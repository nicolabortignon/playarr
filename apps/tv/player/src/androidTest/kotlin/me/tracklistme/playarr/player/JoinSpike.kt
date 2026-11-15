package me.tracklistme.playarr.player

import android.content.Context
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.audio.TeeAudioProcessor
import androidx.media3.exoplayer.source.ClippingMediaSource
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.mp4.FragmentedMp4Extractor
import androidx.media3.extractor.text.SubtitleParser
import androidx.media3.test.utils.FakeExtractorInput
import androidx.media3.test.utils.FakeExtractorOutput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import me.tracklistme.playarr.api.ApiJson
import me.tracklistme.playarr.api.TransitionAnswer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Plan 9 §4's join spike: ExoPlayer plays song A up to a sample, a DJ transition, then song B from a sample, with
 * nothing repeated or lost at the two joins. What reaches the speakers (after Media3's trimming) is written to the test
 * app's files as 16-bit PCM for `scripts/join-spike/analyze.mjs` to compare with the signal (`make join-test`).
 *
 * The assets are the server's own encodes of a 6 s test signal (scripts/join-spike/make-signal.mjs, played by
 * `make demo`): a.mp4 the song's stream, b.mp4 its stream from sample S; t.flac the signal from F to S as the server
 * renders a transition (24-bit FLAC), and ts.mp4 that file through `/transitions/:file/aac?start=487`.
 * What was found, and why transitions play as AAC: plan 9's Progress, 2026-11-15.
 */
@RunWith(AndroidJUnit4::class)
class JoinSpike {
  private val context: Context = InstrumentationRegistry.getInstrumentation().context

  /** The PCM going to the speakers, and when the sink was flushed (a gap or a jump). */
  private class Tap(name: String, dir: File) : TeeAudioProcessor.AudioBufferSink {
    val pcm = FileOutputStream(File(dir, "$name.pcm"))
    val log = File(dir, "$name.txt").also { it.writeText("") }
    var bytes = 0L

    override fun flush(sampleRateHz: Int, channelCount: Int, encoding: Int) {
      log.appendText("flush at frame ${bytes / 4}: $sampleRateHz Hz, $channelCount ch, encoding $encoding\n")
    }

    override fun handleBuffer(buffer: ByteBuffer) {
      val b = ByteArray(buffer.remaining())
      buffer.duplicate().get(b)
      pcm.write(b)
      bytes += b.size
    }
  }

  private class Renderers(context: Context, val tap: Tap) : DefaultRenderersFactory(context) {
    override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
      DefaultAudioSink.Builder(context).setAudioProcessors(arrayOf(TeeAudioProcessor(tap))).build()
  }

  private fun asset(name: String): MediaSource =
    ProgressiveMediaSource.Factory(DefaultDataSource.Factory(context)).createMediaSource(MediaItem.fromUri("asset:///$name"))

  /** The times (µs) of a.mp4's first two AAC frames: frame k starts at t0 + k × (t1 − t0). */
  private fun aacFrameTimes(): Pair<Long, Long> {
    val bytes = context.assets.open("a.mp4").readBytes()
    val extractor = FragmentedMp4Extractor(SubtitleParser.Factory.UNSUPPORTED, 0)
    val output = FakeExtractorOutput()
    extractor.init(output)
    val input = FakeExtractorInput.Builder().setData(bytes).build()
    val position = PositionHolder()
    do {} while (extractor.read(input, position) != Extractor.RESULT_END_OF_INPUT)
    val track = output.trackOutputs.valueAt(0)
    Log.i(TAG, "a.mp4: encoderDelay ${track.lastFormat?.encoderDelay}, padding ${track.lastFormat?.encoderPadding}, ${track.sampleCount} frames")
    return track.getSampleTimeUs(0) to track.getSampleTimeUs(1)
  }

  /** Plays `sources` to the end, tapping the output; `meanwhile` runs on the main thread a second in. */
  private fun play(name: String, sources: List<MediaSource>, meanwhile: ((ExoPlayer) -> Unit)? = null) {
    val dir = context.getExternalFilesDir(null)!!
    val tap = Tap(name, dir)
    val done = CountDownLatch(1)
    var error: PlaybackException? = null
    lateinit var player: ExoPlayer
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      player = ExoPlayer.Builder(context, Renderers(context, tap)).build()
      player.addListener(object : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
          if (state == Player.STATE_ENDED) done.countDown()
        }

        override fun onPlayerError(e: PlaybackException) {
          error = e
          done.countDown()
        }
      })
      player.setMediaSources(sources)
      player.prepare()
      player.play()
    }
    if (meanwhile != null) {
      Thread.sleep(1000)
      InstrumentationRegistry.getInstrumentation().runOnMainSync { meanwhile(player) }
    }
    done.await(60, TimeUnit.SECONDS)
    InstrumentationRegistry.getInstrumentation().runOnMainSync { player.release() }
    tap.pcm.close()
    tap.log.appendText("end at frame ${tap.bytes / 4}\n")
    Log.i(TAG, "$name: ${tap.bytes / 4} frames, ${tap.log.readText().trim()}")
    assertNull(error)
  }

  private fun us(samples: Long): Long = samples * C.MICROS_PER_SECOND / RATE

  /** Just before AAC frame k of a stream starts: clipping there keeps frames 0 to k − 1 whole. */
  private fun frameStartUs(k: Long): Long = us(k * FRAME) - 10

  @Test
  fun joins() {
    val (t0, t1) = aacFrameTimes()
    val frameUs = t1 - t0
    // The first AAC frame boundary at or after F, in samples of the decoded song (the priming comes first).
    val k = (F + PRIMING + FRAME - 1) / FRAME
    val aligned = k * FRAME - PRIMING
    val alignedUs = t0 + k * frameUs
    Log.i(TAG, "frames at $t0 + k × $frameUs µs; F = $F, aligned to $aligned (frame $k at $alignedUs µs)")

    // As the TV plays a DJ transition: A cut at its frame k, the transition as the server encodes it from A's frame
    // boundary (ts.mp4: /transitions/:file/aac?start=aligned − F, to its end), then B from the sample after it
    // (b.mp4: levelled.aac?start=S). All AAC, so one decoder plays the three.
    play("server", listOf(ClippingMediaSource.Builder(asset("a.mp4")).setEndPositionUs(frameStartUs(k)).build(), asset("ts.mp4"), asset("b.mp4")))
    // As the TV really does it: A starts uncut (a CuttableMediaSource), and a second in, as a ready transition
    // arrives, it's cut where Joins says, on the playback thread; the transition from the sample Joins gives (ts2.mp4:
    // /transitions/:file/aac?start=959, for A's padding of 552), then B. The transition file here starts at F, with
    // a one-second lead, and B goes on at S.
    val a = CuttableMediaSource.of(MediaItem.fromUri("asset:///a.mp4"), DefaultDataSource.Factory(context), DefaultLoadErrorHandlingPolicy())
    val ready = ApiJson.reading.decodeFromString(
      TransitionAnswer.ByTag,
      """{"status":"ready","url":"/transitions/x.flac","lead":1,"tail":0,"plan":{"style":"long","aStart":${(F + RATE) / RATE.toDouble()},
        "bStart":0,"length":1,"bResume":${S / RATE.toDouble()},"switchAt":0,"bRate":[],"aGain":[],"bGain":[],"aLowDb":[],"bLowDb":[],
        "aHighPassHz":[],"reason":"","beats":0}}""",
    ) as TransitionAnswer.Ready
    play("cut", listOf(a, asset("ts2.mp4"), asset("b.mp4"))) { player ->
      val join = Joins.of(ready, a.trimmed!!)!!
      Log.i(TAG, "cut: A trims ${a.trimmed}, $join")
      assertEquals(959L, join.transitionStart)
      assertEquals(S, join.bStart)
      player.createMessage { _, _ -> a.cut(join.cutUs) }.setLooper(player.playbackLooper).send()
    }
    // The control: A alone, as gapless playback of the whole song.
    play("whole", listOf(asset("a.mp4")))
  }

  private companion object {
    const val TAG = "JoinSpike"
    const val RATE = 44_100L
    const val PRIMING = 2112L
    const val FRAME = 1024L
    const val F = 88_537L
    const val S = 154_800L
  }
}
