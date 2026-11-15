package me.tracklistme.playarr.tv.playback

import androidx.media3.common.MediaItem
import me.tracklistme.playarr.api.Api
import me.tracklistme.playarr.api.Track
import me.tracklistme.playarr.api.TrackLevel
import me.tracklistme.playarr.player.QueueItems
import me.tracklistme.playarr.tv.PlayarrApp

/** Songs as the player's items, at the quality and level Settings → Playback asks for. */
class Songs(private val app: PlayarrApp) {
  /** The levels the server has measured for these songs (`POST /api/levels`, 50 at a time); none when it can't say. */
  suspend fun levels(tracks: List<Track>): Map<String, TrackLevel> {
    if (!app.playback.now.evenVolume) return emptyMap()
    val client = app.client() ?: return emptyMap()
    val levels = mutableMapOf<String, TrackLevel>()
    tracks.map { it.recordingId }.distinct().chunked(LEVELS_AT_ONCE).forEach { batch ->
      runCatching { client.send(Api.Playback.levels(batch)) }.onSuccess { levels += it }
    }
    return levels
  }

  /** `queue`'s songs from `from` on as items: the songs before are only there for the levels (an album in order). */
  suspend fun items(queue: List<Track>, from: Int = 0): List<MediaItem> {
    val media = app.media() ?: return emptyList()
    val settings = app.playback.now
    return QueueItems.items(queue, levels(queue.drop(from)), media, settings.quality, settings.evenVolume, from)
  }

  private companion object {
    const val LEVELS_AT_ONCE = 50
  }
}
