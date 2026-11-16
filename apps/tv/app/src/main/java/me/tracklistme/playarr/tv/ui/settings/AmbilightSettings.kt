package me.tracklistme.playarr.tv.ui.settings

import android.os.SystemClock
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.Text
import me.tracklistme.playarr.tv.ambilight.Ambilight
import me.tracklistme.playarr.tv.ui.common.TextEntry
import me.tracklistme.playarr.tv.ui.theme.Palette
import me.tracklistme.playarr.tv.ui.theme.Type

/**
 * Settings → Ambilight (plan 9 §6): the switch, off by default, then finding the TV's JointSpace and pairing with the
 * PIN it shows. A TV without JointSpace says so, and nothing else changes.
 */
fun LazyListScope.ambilightSettings(ambilight: Ambilight, enabled: Boolean, status: Ambilight.Status, focus: AmbilightFocus) {
  val tracked = Modifier.onFocusChanged { focus.changed(it.hasFocus) }
  item(key = "ambilight") {
    // The rows below change with the status; if the focus was on one, it comes back here rather than falling to the
    // rail.
    LaunchedEffect(status) { if (focus.wasInside()) runCatching { focus.toggle.requestFocus() } }
    Toggle("Lights follow the music", "The Ambilight takes the colors of the cover playing.", enabled, tracked.focusRequester(focus.toggle)) { on ->
      if (on) ambilight.enable() else ambilight.disable()
    }
  }
  if (!enabled) return
  when (status) {
    Ambilight.Status.Off -> Unit
    Ambilight.Status.Looking -> item(key = "ambilight:looking") { Note("Looking for the TV’s Ambilight…") }
    Ambilight.Status.NotFound -> {
      item(key = "ambilight:none") { Note("This TV doesn’t answer Philips’s JointSpace, so the lights can’t follow the music.") }
      item(key = "ambilight:again") { Box(tracked) { Choice("Look again", "", null, ambilight::enable) } }
    }
    is Ambilight.Status.Pin -> item(key = "ambilight:pin") { Box(tracked) { PinEntry(ambilight::pair) } }
    Ambilight.Status.Ready -> {
      item(key = "ambilight:ready") { Box(tracked) { Choice("Paired with this TV", "", "Your own Ambilight setting comes back half a minute after the music stops.") {} } }
      item(key = "ambilight:pair") { Box(tracked) { Choice("Pair again", "", "If the TV has forgotten Playarr.", ambilight::pairAgain) } }
    }
    is Ambilight.Status.Failed -> {
      item(key = "ambilight:failed") { Note(status.message) }
      item(key = "ambilight:pair") { Box(tracked) { Choice("Pair again", "", null, ambilight::pairAgain) } }
    }
  }
}

/**
 * Whether the focus is among the Ambilight rows, so it isn't lost when they change. A row taken away while focused
 * reports losing the focus as it goes, so a loss just before the change still counts as inside.
 */
class AmbilightFocus {
  val toggle = FocusRequester()
  private var inside = false
  private var leftAt = 0L

  fun changed(hasFocus: Boolean) {
    if (inside && !hasFocus) leftAt = SystemClock.uptimeMillis()
    inside = hasFocus
  }

  fun wasInside(): Boolean = inside || SystemClock.uptimeMillis() - leftAt < 1_000
}

@Composable
internal fun Note(text: String) {
  Text(text, style = Type.rowDetail.copy(color = Palette.muted), modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
}

/** The PIN the TV shows over the app, typed with the remote's numbers. */
@Composable
private fun PinEntry(onPair: (String) -> Unit) {
  var pin by remember { mutableStateOf("") }
  Column {
    Note("The TV is showing a PIN. Type it here to pair.")
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
      TextEntry(
        pin,
        { pin = it.filter(Char::isDigit).take(8) },
        "PIN",
        Modifier.weight(1f),
        icon = Icons.Filled.Lock,
        keyboard = KeyboardType.NumberPassword,
        onDone = { if (pin.isNotEmpty()) onPair(pin) },
      )
      Button(onClick = { if (pin.isNotEmpty()) onPair(pin) }) { Text("Pair", style = Type.label) }
    }
  }
}
