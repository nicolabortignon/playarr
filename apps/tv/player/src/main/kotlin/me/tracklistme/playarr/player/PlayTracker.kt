package me.tracklistme.playarr.player

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import me.tracklistme.playarr.api.PlayReport
import me.tracklistme.playarr.api.Track

/** Why a song stopped being the current one. */
public enum class Finish { Ended, Changed, Closed }

/**
 * The listening history, as heard on this TV (the iOS app's PlayTracker, the web's playTracker.ts): each song is
 * reported once it stops being the current one, with how long it was actually heard (seeking doesn't count) and where
 * in the day. Heard 30 s, or half a shorter song, it's a play; left after 3 s, a skip.
 */
public class PlayTracker(private val zone: () -> ZoneId = ZoneId::systemDefault, private val send: (PlayReport) -> Unit) {
  private class Current(val track: Track, val startedAt: Instant) {
    var heard = 0.0
    var lastTime: Double? = null
  }

  private var current: Current? = null

  public fun start(track: Track, at: Instant = Instant.now()) {
    current = Current(track, at)
  }

  /** The playhead moved while playing (seconds). Jumps (seeks) aren't counted as heard. */
  public fun tick(time: Double) {
    val c = current ?: return
    c.lastTime?.let { last ->
      val delta = time - last
      if (delta > 0 && delta < 2) c.heard += delta
    }
    c.lastTime = time
  }

  /** Paused, or jumped: the next tick starts counting afresh. */
  public fun pause() {
    current?.lastTime = null
  }

  public fun finish(reason: Finish) {
    val c = current ?: return
    current = null
    val duration = if (c.track.duration > 0) c.track.duration else Double.POSITIVE_INFINITY
    val played = c.heard >= minOf(PLAY_SECONDS, duration / 2)
    val skipped = !played && reason == Finish.Changed && c.heard >= SKIP_FROM_SECONDS
    if (!played && !skipped) return
    val local = c.startedAt.atZone(zone())
    send(
      PlayReport(
        trackId = c.track.id,
        recordingId = c.track.recordingId,
        at = DateTimeFormatter.ISO_INSTANT.format(c.startedAt),
        hour = local.hour,
        // 0 for Sunday, as JavaScript's getDay() and the server count.
        weekday = local.dayOfWeek.value % 7,
        seconds = Math.round(c.heard).toDouble(),
        skipped = skipped,
      ),
    )
  }

  public companion object {
    public const val PLAY_SECONDS: Double = 30.0
    public const val SKIP_FROM_SECONDS: Double = 3.0
  }
}
