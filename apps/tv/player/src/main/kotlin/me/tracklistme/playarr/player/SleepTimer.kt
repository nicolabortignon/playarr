package me.tracklistme.playarr.player

import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The sleep timer (the iOS app's SleepTimer, the web's sleep.ts): stop after a while, fading out over the last 20 s,
 * or when this song ends.
 */
public class SleepTimer(private val now: () -> Instant = Instant::now) {
  public data class State(val endsAt: Instant? = null, val endOfSong: Boolean = false)

  private val state = MutableStateFlow(State())
  public val current: StateFlow<State> = state.asStateFlow()

  public fun sleep(minutes: Long) {
    state.value = State(endsAt = now().plus(Duration.ofMinutes(minutes)))
  }

  public fun sleepAtEndOfSong() {
    state.value = State(endOfSong = true)
  }

  public fun cancel() {
    state.value = State()
  }

  /** How loud to play as the timer runs out: 1, then down to 0 over the fade. */
  public fun volume(): Float {
    val endsAt = state.value.endsAt ?: return 1f
    val left = Duration.between(now(), endsAt).toMillis() / 1000.0
    return (left / FADE_SECONDS).coerceIn(0.0, 1.0).toFloat()
  }

  /** True once, when the timer has run out (it's then cancelled): the player pauses. */
  public fun runsOut(): Boolean {
    val endsAt = state.value.endsAt ?: return false
    if (now().isBefore(endsAt)) return false
    cancel()
    return true
  }

  /** "23 min" left, or "End of song", for the timer's button. */
  public fun label(): String? {
    val s = state.value
    if (s.endOfSong) return "End of song"
    val endsAt = s.endsAt ?: return null
    val seconds = Duration.between(now(), endsAt).seconds
    val minutes = maxOf(1, ((seconds + 59) / 60).toInt())
    if (minutes < 60) return "$minutes min"
    return if (minutes % 60 == 0) "${minutes / 60} h" else "${minutes / 60} h ${minutes % 60} min"
  }

  public companion object {
    public const val FADE_SECONDS: Double = 20.0
    /** The lengths offered (minutes), as on the phone. */
    public val OPTIONS: List<Long> = listOf(15, 30, 45, 60, 90)
  }
}
