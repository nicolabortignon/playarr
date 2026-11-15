package me.tracklistme.playarr.player

import me.tracklistme.playarr.api.Track

/** Keeping the music going when the queue ends (the iOS app's Radio, the web's useAutoplay): songs like the last few. */
public object Radio {
  /** Songs to base what comes next on: the last few played. */
  public const val SEEDS: Int = 5
  public const val COUNT: Int = 25

  public data class Ask(val seeds: List<String>, val exclude: List<String>)

  /**
   * What to ask `POST /api/radio` for as a song starts, or null: only on the queue's last song, with nothing repeating
   * and "Keep playing when the queue ends" on. `played` is the queue in play order up to the song starting.
   */
  public fun continuation(played: List<Track>, queue: List<Track>, last: Boolean, repeating: Boolean, autoplay: Boolean): Ask? {
    if (!autoplay || repeating || !last || played.isEmpty()) return null
    return Ask(played.takeLast(SEEDS).map { it.recordingId }, queue.map { it.recordingId }.distinct())
  }
}
