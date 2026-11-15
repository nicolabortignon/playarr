package me.tracklistme.playarr.player

import java.time.Duration
import java.time.Instant
import me.tracklistme.playarr.api.AudioFormat
import me.tracklistme.playarr.api.MediaUrls
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamQualityTests {
  private val media = MediaUrls("http://nas.local:4533", token = "t")
  private val flac = track(7).copy(format = AudioFormat(codec = "FLAC", container = "flac", bits = 16, sampleRate = 44_100, lossless = true), size = 30_000_000)
  private val hiRes = flac.copy(format = flac.format.copy(bits = 24, sampleRate = 96_000))
  private val mp3At128 = track(8).copy(format = AudioFormat(codec = "MP3", container = "mp3", bitrate = 128.0, lossless = false))

  @Test
  fun highIsTheEncodedStreamLevelledByTheServerWhenItKnowsTheGain() {
    assertEquals("http://nas.local:4533/stream/7/levelled.aac?kbps=256&gain=-4.3", StreamQuality.High.uri(flac, media, -4.3))
    assertEquals("http://nas.local:4533/stream/7/aac?kbps=128", StreamQuality.Normal.uri(flac, media, null))
  }

  @Test
  fun aFileAlreadyAboutThatSmallPlaysAsItIsUnlessItNeedsLevelling() {
    assertEquals("http://nas.local:4533/stream/8", StreamQuality.Normal.uri(mp3At128, media, null))
    assertEquals("http://nas.local:4533/stream/8/levelled.aac?kbps=128&gain=1.5", StreamQuality.Normal.uri(mp3At128, media, 1.5))
  }

  @Test
  fun originalIsTheLevelledWavOrAFileTheTvDecodesOrElseTheHighStream() {
    assertEquals("http://nas.local:4533/stream/7/levelled.wav?gain=-2.0", StreamQuality.Original.uri(hiRes, media, -2.0))
    assertEquals("http://nas.local:4533/stream/7", StreamQuality.Original.uri(flac, media, null))
    assertEquals("http://nas.local:4533/stream/7/aac?kbps=256", StreamQuality.Original.uri(hiRes, media, null))
  }

  @Test
  fun aSongFromElsewhereIsNeverEncoded() {
    assertEquals("https://cdn.example/song.mp3", StreamQuality.High.uri(flac.copy(streamUrl = "https://cdn.example/song.mp3"), media, -3.0))
  }

  @Test
  fun anUnknownSettingIsHigh() {
    assertEquals(StreamQuality.High, StreamQuality.of(null))
    assertEquals(StreamQuality.High, StreamQuality.of("Lossless"))
    assertEquals(StreamQuality.Original, StreamQuality.of("Original"))
  }
}

class SleepTimerTests {
  private var now = Instant.parse("2026-11-15T22:00:00Z")
  private val timer = SleepTimer { now }

  @Test
  fun itFadesOverTheLastTwentySecondsThenRunsOutOnce() {
    timer.sleep(30)
    assertEquals("30 min", timer.label())
    assertEquals(1f, timer.volume())
    now = now.plus(Duration.ofMinutes(30)).minusSeconds(10)
    assertEquals(0.5f, timer.volume(), 0.001f)
    assertFalse(timer.runsOut())
    now = now.plusSeconds(10)
    assertTrue(timer.runsOut())
    assertFalse(timer.runsOut())
    assertNull(timer.label())
    assertEquals(1f, timer.volume())
  }

  @Test
  fun labelsRoundUpToTheMinuteAndShowHours() {
    timer.sleep(90)
    assertEquals("1 h 30 min", timer.label())
    now = now.plus(Duration.ofMinutes(30))
    assertEquals("1 h", timer.label())
    now = now.plus(Duration.ofMinutes(59)).plusSeconds(30)
    assertEquals("1 min", timer.label())
    timer.sleepAtEndOfSong()
    assertEquals("End of song", timer.label())
    assertFalse(timer.runsOut())
  }
}

class RadioTests {
  private val queue = (1..8).map { track(it) }

  @Test
  fun onTheLastSongItAsksForSongsLikeTheLastFiveLeavingOutTheQueue() {
    val ask = Radio.continuation(queue, queue, last = true, repeating = false, autoplay = true)!!
    assertEquals((4..8).map { "track:$it" }, ask.seeds)
    assertEquals(queue.map { it.recordingId }, ask.exclude)
  }

  @Test
  fun notBeforeTheEndNorWhileRepeatingNorWithAutoplayOff() {
    assertNull(Radio.continuation(queue.take(3), queue, last = false, repeating = false, autoplay = true))
    assertNull(Radio.continuation(queue, queue, last = true, repeating = true, autoplay = true))
    assertNull(Radio.continuation(queue, queue, last = true, repeating = false, autoplay = false))
  }
}
