package me.tracklistme.playarr.player

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import me.tracklistme.playarr.api.ApiJson
import me.tracklistme.playarr.api.MediaUrls
import me.tracklistme.playarr.api.Track
import me.tracklistme.playarr.api.TrackLevel

/**
 * Songs as Media3 items: the server's encoded stream (AAC at 256 kbps in fragmented MP4, gapless by its iTunSMPB),
 * levelled to the song's gain when even volume knows it (`levelled.aac`, plan 9 §4), with the title, artist, album and
 * cover the system's Now Playing card shows. The Track itself rides along in the extras, so the queue can be read back.
 */
public object QueueItems {
  public const val KBPS: Int = 256
  private const val TRACK = "playarr.track"

  public fun items(queue: List<Track>, levels: Map<String, TrackLevel>, media: MediaUrls, evenVolume: Boolean = true): List<MediaItem> =
    queue.mapIndexed { index, track ->
      val gain = if (evenVolume) levels[track.recordingId]?.let { roundGain(JoinRules.levelDb(queue, index, it)) } else null
      item(track, media, gain)
    }

  public fun item(track: Track, media: MediaUrls, gain: Double?): MediaItem =
    MediaItem.Builder()
      .setMediaId("${track.fileId}:${gain ?: "-"}")
      .setUri(media.encoded(track, KBPS, gain))
      .setMimeType("audio/mp4")
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(track.title)
          .setArtist(track.artistName)
          .setAlbumTitle(track.albumTitle)
          .setTrackNumber(track.trackNumber)
          .setDiscNumber(track.discNumber)
          .setArtworkUri(media.art(track.coverUrl, 512)?.let(Uri::parse))
          .setIsPlayable(true)
          .setIsBrowsable(false)
          .setExtras(Bundle().apply { putString(TRACK, ApiJson.writing.encodeToString(Track.serializer(), track)) })
          .build(),
      )
      .build()

  /** The Track an item was made from. */
  public fun track(item: MediaItem?): Track? =
    item?.mediaMetadata?.extras?.getString(TRACK)?.let { runCatching { ApiJson.reading.decodeFromString(Track.serializer(), it) }.getOrNull() }

  /** To a tenth of a dB: the same song at the same level is the same URL, so the server's cache serves it again. */
  public fun roundGain(db: Double): Double = Math.round(db * 10) / 10.0
}
