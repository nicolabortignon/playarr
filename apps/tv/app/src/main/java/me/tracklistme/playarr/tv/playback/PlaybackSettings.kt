package me.tracklistme.playarr.tv.playback

import android.content.Context
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import me.tracklistme.playarr.player.StreamQuality

/** Settings → Playback, on this TV (the phone's PlaybackSettings, less what a TV has no use for). */
class PlaybackSettings(context: Context) {
  enum class Transitions { Off, Crossfade, Dj }

  data class Values(
    val quality: StreamQuality = StreamQuality.High,
    val transitions: Transitions = Transitions.Off,
    /** Seconds songs overlap with Crossfade. */
    val crossfade: Int = 6,
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
      putInt(CROSSFADE, v.crossfade)
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
      crossfade = prefs.getInt(CROSSFADE, d.crossfade).takeIf { it in CROSSFADES } ?: d.crossfade,
      evenVolume = prefs.getBoolean(EVEN_VOLUME, d.evenVolume),
      autoplay = prefs.getBoolean(AUTOPLAY, d.autoplay),
      recordPlays = prefs.getBoolean(RECORD_PLAYS, d.recordPlays),
    )
  }

  companion object {
    /** The crossfade lengths offered (seconds), as on the web and the phone. */
    val CROSSFADES = listOf(3, 6, 9, 12)
    private const val QUALITY = "quality"
    private const val TRANSITIONS = "transitions"
    private const val CROSSFADE = "crossfade"
    private const val EVEN_VOLUME = "evenVolume"
    private const val AUTOPLAY = "autoplay"
    private const val RECORD_PLAYS = "recordPlays"
  }
}
