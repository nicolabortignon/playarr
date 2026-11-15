package me.tracklistme.playarr.player

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import java.util.UUID
import me.tracklistme.playarr.api.ApiJson
import me.tracklistme.playarr.api.MediaUrls
import me.tracklistme.playarr.api.Track
import me.tracklistme.playarr.api.TrackLevel

/**
 * Songs as Media3 items: by default the server's encoded stream (AAC at 256 kbps in fragmented MP4, gapless by its
 * iTunSMPB), levelled to the song's gain when even volume knows it (`levelled.aac`, plan 9 §4; other qualities in
 * StreamQuality), with the title, artist, album and cover the system's Now Playing card shows. The Track itself, the
 * gain it plays at and which part of it the item is ride along in the extras, so the queue can be read back.
 *
 * A DJ transition (Joins) makes a song's join two items: the transition (`Part.Transition`, B's as the listener hears
 * B come in) and the rest of B from where the transition ends (`Part.Rest`).
 */
public object QueueItems {
  private const val TRACK = "playarr.track"
  private const val GAIN = "playarr.gain"
  private const val PART = "playarr.part"

  public enum class Part { Song, Transition, Rest }

  /**
   * `queue`'s songs from `from` on, each at its level within the queue (an album in order at the album's): the songs
   * before `from` are there for that only (the song playing, when more are added after it).
   */
  public fun items(
    queue: List<Track>,
    levels: Map<String, TrackLevel>,
    media: MediaUrls,
    quality: StreamQuality = StreamQuality.High,
    evenVolume: Boolean = true,
    from: Int = 0,
  ): List<MediaItem> =
    (from until queue.size).map { index ->
      val track = queue[index]
      val gain = if (evenVolume) levels[track.recordingId]?.let { roundGain(JoinRules.levelDb(queue, index, it)) } else null
      item(track, quality.uri(track, media, gain), media, gain)
    }

  /** An entry of the queue: its id is its own, so the same song twice is two entries. */
  public fun item(track: Track, uri: String, media: MediaUrls, gain: Double? = null, part: Part = Part.Song): MediaItem =
    MediaItem.Builder()
      .setMediaId("${track.fileId}:${UUID.randomUUID()}")
      .setUri(uri)
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
          .setExtras(
            Bundle().apply {
              putString(TRACK, ApiJson.writing.encodeToString(Track.serializer(), track))
              gain?.let { putDouble(GAIN, it) }
              putString(PART, part.name)
            },
          )
          .build(),
      )
      .build()

  /** The Track an item was made from. */
  public fun track(item: MediaItem?): Track? =
    item?.mediaMetadata?.extras?.getString(TRACK)?.let { runCatching { ApiJson.reading.decodeFromString(Track.serializer(), it) }.getOrNull() }

  /** The gain (dB) the item's stream is levelled to; null when it isn't. */
  public fun gain(item: MediaItem?): Double? = item?.mediaMetadata?.extras?.takeIf { it.containsKey(GAIN) }?.getDouble(GAIN)

  public fun part(item: MediaItem?): Part = item?.mediaMetadata?.extras?.getString(PART)?.let { p -> Part.entries.firstOrNull { it.name == p } } ?: Part.Song

  /** A whole song as the server's encoded stream: one a DJ transition can cut (SongSources makes it cuttable). */
  public fun isEncodedSong(item: MediaItem): Boolean {
    val path = item.localConfiguration?.uri?.path ?: return false
    return part(item) == Part.Song && (path.endsWith("/aac") || path.endsWith("/levelled.aac"))
  }

  /** The kbps an encoded item's stream is at (256 unless it says). */
  public fun kbps(item: MediaItem): Int = item.localConfiguration?.uri?.getQueryParameter("kbps")?.toIntOrNull() ?: StreamQuality.High.kbps!!

  /** To a tenth of a dB: the same song at the same level is the same URL, so the server's cache serves it again. */
  public fun roundGain(db: Double): Double = Math.round(db * 10) / 10.0
}
