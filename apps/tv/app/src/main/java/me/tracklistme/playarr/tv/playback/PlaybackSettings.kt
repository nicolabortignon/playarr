package me.tracklistme.playarr.tv.playback

import android.content.Context
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import me.tracklistme.playarr.player.StreamQuality

/** Settings → Playback, on this TV (the phone's PlaybackSettings, less what a TV has no use for). */
class PlaybackSettings(context: Context) {
  /** How songs follow each other: gapless (Off), or joined by the server's DJ transitions. No crossfade on the TV yet. */
  enum class Transitions { Off, Dj }

  data class Values(
    val quality: StreamQuality = StreamQuality.High,
    val transitions: Transitions = Transitions.Off,
    /** "Even out the volume". */
    val evenVolume: Boolean = true,
    /** "Keep playing when the queue ends". */
    val autoplay: Boolean = true,
    /** "Count what this TV plays": the plays heard here go into the account's history. */
    val recordPlays: Boolean = true,
  )

  private val prefs = context.getSharedPreferences("playback", Context.MODE_PRIVATE)
  private val state = MutableStateFlow(read())
  val values: StateFlow<Values> = state.asStateFlow()
  val now: Values get() = state.value

  fun update(change: (Values) -> Values) {
    val v = change(state.value)
    prefs.edit {
      putString(QUALITY, v.quality.name)
      putString(TRANSITIONS, v.transitions.name)
      putBoolean(EVEN_VOLUME, v.evenVolume)
      putBoolean(AUTOPLAY, v.autoplay)
      putBoolean(RECORD_PLAYS, v.recordPlays)
    }
    state.value = v
  }

  private fun read(): Values {
    val d = Values()
    return Values(
      quality = StreamQuality.of(prefs.getString(QUALITY, null)),
      transitions = Transitions.entries.firstOrNull { it.name == prefs.getString(TRANSITIONS, null) } ?: d.transitions,
      evenVolume = prefs.getBoolean(EVEN_VOLUME, d.evenVolume),
      autoplay = prefs.getBoolean(AUTOPLAY, d.autoplay),
      recordPlays = prefs.getBoolean(RECORD_PLAYS, d.recordPlays),
    )
  }

  companion object {
    private const val QUALITY = "quality"
    private const val TRANSITIONS = "transitions"
    private const val EVEN_VOLUME = "evenVolume"
    private const val AUTOPLAY = "autoplay"
    private const val RECORD_PLAYS = "recordPlays"
  }
}
