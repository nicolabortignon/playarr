package me.tracklistme.playarr.player

import java.time.Instant
import java.time.ZoneId
import me.tracklistme.playarr.api.AudioFormat
import me.tracklistme.playarr.api.PlayReport
import me.tracklistme.playarr.api.Track
import me.tracklistme.playarr.api.TrackLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

internal fun track(id: Int, album: Int = 1, number: Int = id, disc: Int = 1, duration: Double = 200.0): Track =
  Track(
    id = id, recordingId = "track:$id", fileId = id, albumId = album, artistId = 1, title = "Song $id", artistName = "Artist",
    albumTitle = "Album $album", trackNumber = number, discNumber = disc, duration = duration, explicit = false,
    format = AudioFormat(codec = "flac", container = "flac", lossless = true), size = 1, streamUrl = "/stream/$id",
  )

class JoinRulesTests {
  @Test
  fun theNextSongOnTheDiscOrTheFirstOfTheNextDiscContinuesTheAlbum() {
    assertTrue(JoinRules.continues(track(1), track(2)))
    assertTrue(JoinRules.continues(track(9, disc = 1), track(10, number = 1, disc = 2)))
    assertFalse(JoinRules.continues(track(1), track(3)))
    assertFalse(JoinRules.continues(track(2), track(1)))
    assertFalse(JoinRules.continues(track(1), track(2, album = 2)))
    assertFalse(JoinRules.continues(null, track(1)))
  }

  @Test
  fun anAlbumInOrderPlaysAtTheAlbumsLevelAndAShuffleAtEachSongs() {
    val level = TrackLevel(track = -3.0, album = -5.0)
    val inOrder = listOf(track(1), track(2), track(3))
    assertEquals(-5.0, JoinRules.levelDb(inOrder, 0, level), 0.0)
    assertEquals(-5.0, JoinRules.levelDb(inOrder, 2, level), 0.0)
    val shuffled = listOf(track(3), track(1, album = 2), track(7))
    assertEquals(-3.0, JoinRules.levelDb(shuffled, 1, level), 0.0)
    // An album without its own level: the song's.
    assertEquals(-3.0, JoinRules.levelDb(inOrder, 1, TrackLevel(track = -3.0)), 0.0)
  }

  @Test
  fun gainsAreRoundedToATenthOfADecibel() {
    assertEquals(-4.3, QueueItems.roundGain(-4.2649), 0.0)
    assertEquals(2.0, QueueItems.roundGain(1.96), 0.0)
    assertEquals(-0.1, QueueItems.roundGain(-0.05001), 0.0)
  }
}

class PlayTrackerTests {
  private val sent = mutableListOf<PlayReport>()
  // Sunday 2026-11-15, 21:30 in Rome.
  private val tracker = PlayTracker({ ZoneId.of("Europe/Rome") }) { sent += it }
  private val start = Instant.parse("2026-11-15T20:30:00Z")

  private fun hear(seconds: Int, from: Int = 0) {
    for (t in from..from + seconds) tracker.tick(t.toDouble())
  }

  @Test
  fun thirtySecondsHeardIsAPlayInTheListenersHourAndWeekday() {
    tracker.start(track(1), start)
    hear(31)
    tracker.finish(Finish.Changed)
    val report = sent.single()
    assertEquals(1, report.trackId)
    assertEquals("2026-11-15T20:30:00Z", report.at)
    assertEquals(21, report.hour)
    assertEquals(0, report.weekday)
    assertEquals(31.0, report.seconds, 0.0)
    assertFalse(report.skipped)
  }

  @Test
  fun halfOfAShortSongIsAPlay() {
    tracker.start(track(1, duration = 20.0), start)
    hear(10)
    tracker.finish(Finish.Ended)
    assertFalse(sent.single().skipped)
  }

  @Test
  fun leftAfterAFewSecondsIsASkipButClosingTheAppIsNot() {
    tracker.start(track(1), start)
    hear(5)
    tracker.finish(Finish.Changed)
    assertTrue(sent.single().skipped)
    tracker.start(track(2), start)
    hear(5)
    tracker.finish(Finish.Closed)
    tracker.start(track(3), start)
    hear(2)
    tracker.finish(Finish.Changed)
    assertEquals(1, sent.size)
  }

  @Test
  fun seekingAndPausingDontCountAsHeard() {
    tracker.start(track(1), start)
    hear(10)
    // Jumped to 2:00.
    hear(10, from = 120)
    tracker.pause()
    hear(5, from = 130)
    tracker.finish(Finish.Changed)
    assertEquals(25.0, sent.single().seconds, 0.0)
    assertTrue(sent.single().skipped)
  }
}
