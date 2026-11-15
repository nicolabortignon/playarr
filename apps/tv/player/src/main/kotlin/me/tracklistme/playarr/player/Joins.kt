package me.tracklistme.playarr.player

import kotlin.math.roundToLong
import me.tracklistme.playarr.api.TransitionAnswer

/**
 * Where a DJ transition joins the songs on the TV (plan 9 §4; the join spike, `make join-test`): song A is cut at an
 * AAC frame boundary inside the transition's lead, where A and the file hold the same sound; the transition plays
 * encoded by the server from the sample that boundary falls on (`/transitions/:file/aac?start=`) to its end; then B
 * goes on from the sample after the transition (`levelled.aac?start=`). All three are AAC, so one decoder plays them
 * and both joins are exact.
 *
 * The file (packages/mix/src/render/transition.ts) is `lead` seconds of A, the mix, then `tail` seconds of B, each
 * rounded to samples. Its first sample is A's `round(aStart × 44 100) − lead`, and B's sample `round(bResume × 44 100)`
 * follows the mix.
 */
public object Joins {
  public const val RATE: Long = 44_100
  /** The server's AAC priming: decoded sample n of a stream is frame (n + PRIMING) / FRAME's. */
  public const val PRIMING: Long = 2112
  public const val FRAME: Long = 1024

  /**
   * @property cutFrame A's stream is clipped before this AAC frame.
   * @property cutUs where to clip it: just before frame `cutFrame` starts, so the frames before it play whole.
   * @property endSample the first sample of A not heard: the frame boundary, less the padding the player trims.
   * @property transitionStart the transition file's sample to start from (A's `endSample`).
   * @property bStart B's sample after the transition: B's stream goes on from here.
   */
  public data class Join(val cutFrame: Long, val cutUs: Long, val endSample: Long, val transitionStart: Long, val bStart: Long) {
    /** Seconds into A where it stops. */
    val endSeconds: Double get() = endSample.toDouble() / RATE
  }

  public fun samples(seconds: Double): Long = (seconds * RATE).roundToLong()

  /**
   * The join for a ready transition, or null when its lead is too short to hold a frame boundary. `padding` is what
   * the player trims off the end of A's stream whatever its cut (CuttableMediaSource.trimmed): A stops that many
   * samples before the boundary.
   */
  public fun of(ready: TransitionAnswer.Ready, padding: Int): Join? {
    val leadSamples = samples(ready.lead ?: 0.0)
    val fileStart = samples(ready.plan.aStart) - leadSamples
    if (fileStart < 0 || padding < 0) return null
    val cutFrame = (fileStart + padding + PRIMING + FRAME - 1) / FRAME
    val endSample = cutFrame * FRAME - PRIMING - padding
    val start = endSample - fileStart
    // A must stop within the lead, where the file is A as it is.
    if (start >= leadSamples) return null
    return Join(
      cutFrame = cutFrame,
      cutUs = cutFrame * FRAME * 1_000_000 / RATE - 10,
      endSample = endSample,
      transitionStart = start,
      bStart = samples(ready.plan.bResume) + samples(ready.tail ?: 0.0),
    )
  }
}
