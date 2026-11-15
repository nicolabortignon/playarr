package me.tracklistme.playarr.player

import android.content.Context
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.Format
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
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.flac.FlacExtractor
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
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Plan 9 §4's join spike: can ExoPlayer play song A up to a sample, a DJ transition (a FLAC whose first part is A as it
 * is), then song B from a sample, with nothing repeated or lost at the two joins? Each configuration's output, after
 * Media3's trimming, is written to the test app's files as 16-bit PCM for `build/spike/analyze.mjs` to compare with the
 * signal. The assets come from `make demo` (a.mp4 and b.mp4 are the server's encoded streams of a 6 s test signal,
 * b.mp4 from sample S; t.flac is the signal from F to S, made as the server makes transitions).
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

  /** An extractor whose track says the decoder should drop `delay` samples first, as for an encoder's priming. */
  private class Delayed(private val inner: Extractor, private val delay: Int) : Extractor by inner {
    override fun init(output: ExtractorOutput) =
      inner.init(object : ExtractorOutput by output {
        override fun track(id: Int, type: Int): TrackOutput {
          val track = output.track(id, type)
          return object : TrackOutput by track {
            override fun format(format: Format) = track.format(format.buildUpon().setEncoderDelay(delay).build())
          }
        }
      })
  }

  private fun asset(name: String, extractors: ExtractorsFactory? = null): MediaSource {
    val data = DefaultDataSource.Factory(context)
    val factory = if (extractors != null) ProgressiveMediaSource.Factory(data, extractors) else ProgressiveMediaSource.Factory(data)
    return factory.createMediaSource(MediaItem.fromUri("asset:///$name"))
  }

  /** The times (µs) of a.mp4's first two AAC frames: frame k starts at t0 + k × (t1 − t0). */
  private fun aacFrameTimes(): Pair<Long, Long> {
    val bytes = context.assets.open("a.mp4").readBytes()
    val extractor = FragmentedMp4Extractor(SubtitleParser.Factory.UNSUPPORTED, 0)
    val output = FakeExtractorOutput()
    extractor.init(output)
    val input = FakeExtractorInput.Builder().setData(bytes).build()
    val position = PositionHolder()
    while (extractor.read(input, position) != Extractor.RESULT_END_OF_INPUT) Unit
    val track = output.trackOutputs.valueAt(0)
    Log.i(TAG, "a.mp4: encoderDelay ${track.lastFormat?.encoderDelay}, padding ${track.lastFormat?.encoderPadding}, ${track.sampleCount} frames")
    return track.getSampleTimeUs(0) to track.getSampleTimeUs(1)
  }

  private fun play(name: String, sources: List<MediaSource>) {
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

    // All AAC, one decoder throughout: A to its frame k, a transition encoded from there (t.mp4: the signal from
    // `aligned`) clipped at its own frame j, and B from the sample after (b2.mp4: from 155 520).
    val j = (S + PRIMING - aligned + FRAME - 1) / FRAME
    Log.i(TAG, "aac: transition to its frame $j, B from ${aligned + j * FRAME - PRIMING}")
    play(
      "aac",
      listOf(
        ClippingMediaSource.Builder(asset("a.mp4")).setEndPositionUs(frameStartUs(k)).build(),
        ClippingMediaSource.Builder(asset("t.mp4")).setEndPositionUs(frameStartUs(j)).build(),
        asset("b2.mp4"),
      ),
    )
    // A clipped at an AAC frame boundary, the transition's first samples dropped as an encoder delay.
    val delay = (aligned - F).toInt()
    play(
      "delay",
      listOf(
        ClippingMediaSource.Builder(asset("a.mp4")).setEndPositionUs(frameStartUs(k)).build(),
        asset("t.flac") { arrayOf(Delayed(FlacExtractor(), delay)) },
        asset("b.mp4"),
      ),
    )
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
