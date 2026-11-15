package me.tracklistme.playarr.player

import me.tracklistme.playarr.api.Track
import me.tracklistme.playarr.api.TrackLevel

/** How songs follow one another (the iOS app's JoinRules, the web's): albums in order, and the level each plays at. */
public object JoinRules {
  /** `b` is the song after `a` on the same album: the next on its disc, or the first of the next disc. */
  public fun continues(a: Track?, b: Track?): Boolean {
    if (a == null || b == null || a.albumId != b.albumId) return false
    return (b.discNumber == a.discNumber && b.trackNumber == a.trackNumber + 1) || (b.discNumber == a.discNumber + 1 && b.trackNumber == 1)
  }

  /**
   * How much to turn the song at `index` of `queue` (dB) so it's as loud as the others: within an album played in
   * order the album's level, so its quiet songs stay quiet next to its loud ones.
   */
  public fun levelDb(queue: List<Track>, index: Int, level: TrackLevel): Double {
    val track = queue[index]
    val inAlbum = continues(queue.getOrNull(index - 1), track) || continues(track, queue.getOrNull(index + 1))
    return if (inAlbum) level.album ?: level.track else level.track
  }
}
