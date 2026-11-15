package me.tracklistme.playarr.player

import me.tracklistme.playarr.api.ApiError
import me.tracklistme.playarr.api.MixMode
import me.tracklistme.playarr.api.Track
import me.tracklistme.playarr.api.TransitionAnswer
import me.tracklistme.playarr.api.TransitionRequest

/**
 * Asks the server for the DJ transition from the song playing into the next while it plays, so it's rendered by the
 * time it's needed: the iOS app's TransitionPlanner (and the web's watchUpcomingTransition), on the TV's tick.
 *
 * - Only once the song has played 5 s (skipping through songs renders nothing), and 2 s after the pair settles.
 * - While the server renders: asked again every 3 s, after 5 polls every 10 s.
 * - A lost connection, 429 or a server error: again after 3 s, then every 10 s. Another refusal ends it.
 * - "Unavailable" is asked once more after 60 s (the songs' analysis may have finished meanwhile).
 * - Not ready 20 s before the mix point: given up, and the songs follow each other gapless.
 * - The position sent is the one at the first ask, unchanged after: the plan (and its render) depends on it.
 *
 * `ask` sends the request and calls back with the answer or the failure (on the thread `tick` runs on).
 */
public class TransitionAsker(
  private val now: () -> Long,
  private val ask: (TransitionRequest, (Result<TransitionAnswer>) -> Unit) -> Unit,
) {
  /** A pair the player wants mixed. `key` tells pairs apart (the same songs elsewhere in the queue are another). */
  public data class Pair(val key: String, val from: Track, val to: Track, val albumQueue: Boolean, val levels: TransitionAnswer.Ready.Levels?)

  /** Told once per pair when its transition is ready in time. */
  public var onReady: ((Pair, TransitionAnswer.Ready) -> Unit)? = null

  private class Asking(val pair: Pair, val settledAt: Long) {
    var played = 0.0
    var lastPosition: Double? = null
    var position: Double? = null
    var asking = false
    var nextAt = 0L
    var polls = 0
    var errors = 0
    var askedAgainUnavailable = false
    var aStart: Double? = null
    var ended = false
  }

  private var current: Asking? = null

  /** The pair wanted now (null: none), and where the song playing is (seconds). Called on every tick while playing. */
  public fun tick(pair: Pair?, position: Double) {
    if (pair?.key != current?.pair?.key) current = pair?.let { Asking(it, now()) }
    val a = current ?: return
    a.lastPosition?.let { last -> (position - last).takeIf { it > 0 && it < 2 }?.let { a.played += it } }
    a.lastPosition = position
    if (a.ended || a.asking) return
    if (tooLate(a, position)) {
      a.ended = true
      return
    }
    if (a.played < MIN_PLAYED || now() < maxOf(a.nextAt, a.settledAt + FIRST_ASK_DELAY_MS)) return
    a.asking = true
    val sent = a.position ?: position.also { a.position = it }
    val request = TransitionRequest(
      from = a.pair.from.id,
      to = a.pair.to.id,
      mode = MixMode.Auto,
      position = sent,
      fromFileId = a.pair.from.fileId,
      toFileId = a.pair.to.fileId,
      albumQueue = a.pair.albumQueue,
      levels = a.pair.levels,
    )
    ask(request) { result -> answered(a, result) }
  }

  private fun tooLate(a: Asking, position: Double): Boolean = position >= (a.aStart ?: a.pair.from.duration) - GIVE_UP_SECONDS

  private fun answered(a: Asking, result: Result<TransitionAnswer>) {
    // Another pair meanwhile: this answer is for nothing now.
    if (current !== a) return
    a.asking = false
    val answer = result.getOrElse { return failed(a, it) }
    a.errors = 0
    when (answer) {
      is TransitionAnswer.Ready -> {
        a.aStart = answer.plan.aStart
        a.ended = true
        if (!tooLate(a, a.lastPosition ?: 0.0)) onReady?.invoke(a.pair, answer)
      }
      is TransitionAnswer.Pending -> {
        a.aStart = answer.plan.aStart
        a.polls++
        a.nextAt = now() + if (a.polls >= FAST_POLLS) SLOW_POLL_MS else POLL_MS
      }
      is TransitionAnswer.Unavailable ->
        if (a.askedAgainUnavailable) a.ended = true else {
          a.askedAgainUnavailable = true
          a.nextAt = now() + UNAVAILABLE_RETRY_MS
        }
      else -> a.ended = true
    }
  }

  private fun failed(a: Asking, error: Throwable) {
    val passing = when (error) {
      is ApiError.Server -> error.status == 429 || error.status >= 500
      is ApiError.Unauthorized -> false
      else -> true // offline, or an answer that didn't decode: likely to pass
    }
    if (!passing) {
      a.ended = true
      return
    }
    a.nextAt = now() + RETRY_MS[minOf(a.errors, RETRY_MS.lastIndex)]
    a.errors++
  }

  public companion object {
    public const val MIN_PLAYED: Double = 5.0
    public const val FIRST_ASK_DELAY_MS: Long = 2_000
    public const val POLL_MS: Long = 3_000
    public const val SLOW_POLL_MS: Long = 10_000
    public const val FAST_POLLS: Int = 5
    public val RETRY_MS: List<Long> = listOf(3_000, 10_000)
    public const val UNAVAILABLE_RETRY_MS: Long = 60_000
    public const val GIVE_UP_SECONDS: Double = 20.0
  }
}
