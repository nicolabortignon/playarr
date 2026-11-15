package me.tracklistme.playarr.api

import org.junit.Assert.assertEquals
import org.junit.Test

class MediaUrlsTests {
  private val media = MediaUrls("http://nas.local:4533", token = "t")
  private val song = Track(
    id = 1, recordingId = "rec", fileId = 9, albumId = 1, artistId = 1, title = "Song", artistName = "Artist", albumTitle = "Album",
    trackNumber = 1, discNumber = 1, duration = 200.0, explicit = false, format = AudioFormat(codec = "FLAC", container = "flac", lossless = true),
    size = 1, streamUrl = "/stream/9",
  )

  @Test
  fun encodedStreamsFromASampleOn() {
    assertEquals("http://nas.local:4533/stream/9/levelled.aac?kbps=256&gain=-3.5&start=154800", media.encoded(song, 256, -3.5, 154_800))
    assertEquals("http://nas.local:4533/stream/9/aac?kbps=128", media.encoded(song, 128))
  }

  @Test
  fun aTransitionAsAacFromASample() {
    assertEquals("http://nas.local:4533/transitions/abc.flac/aac?kbps=256&start=959", media.transitionAac("/transitions/abc.flac", 256, 959))
    assertEquals("http://nas.local:4533/transitions/abc.flac/aac?kbps=128", media.transitionAac("/transitions/abc.flac", 128, 0))
  }

  @Test
  fun theTokenOnlyForThisServer() {
    assertEquals(mapOf("Authorization" to "Bearer t"), media.headers("http://nas.local:4533/transitions/abc.flac/aac"))
    assertEquals(emptyMap<String, String>(), media.headers("https://elsewhere.example/a.mp3"))
  }
}
