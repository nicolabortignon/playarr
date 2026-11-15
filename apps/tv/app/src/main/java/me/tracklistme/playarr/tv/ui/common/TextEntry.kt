package me.tracklistme.playarr.tv.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ButtonDefaults
import androidx.tv.material3.OutlinedButton
import me.tracklistme.playarr.tv.ui.theme.Palette
import me.tracklistme.playarr.tv.ui.theme.Type

/**
 * A text field for the remote: a button until chosen, so the TV's keyboard doesn't cover the screen as the page
 * opens; OK opens the keyboard (its microphone key, where the remote has one, types by voice), Done or moving away
 * closes it. `focus` lets the page give the button the first focus.
 */
@Composable
fun SearchEntry(value: String, onChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier, focus: FocusRequester? = null) {
  var editing by remember { mutableStateOf(false) }
  var focused by remember { mutableStateOf(false) }
  val field = remember { FocusRequester() }
  val shape = RoundedCornerShape(12.dp)
  if (!editing) {
    // As wide as the page: it doesn't grow on focus (it would cover what's beside it), it lights up.
    OutlinedButton(
      onClick = { editing = true },
      scale = ButtonDefaults.scale(focusedScale = 1f),
      modifier = modifier.fillMaxWidth().then(focus?.let { Modifier.focusRequester(it) } ?: Modifier),
    ) {
      IconLabel(Icons.Filled.Search, value.ifEmpty { placeholder })
    }
    return
  }
  LaunchedEffect(Unit) { runCatching { field.requestFocus() } }
  BasicTextField(
    value = value,
    onValueChange = onChange,
    singleLine = true,
    textStyle = Type.body,
    cursorBrush = SolidColor(Palette.accent),
    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
    keyboardActions = KeyboardActions(onSearch = { editing = false }),
    decorationBox = { inner ->
      Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
        if (value.isEmpty()) androidx.tv.material3.Text(placeholder, style = Type.body.copy(color = Palette.muted))
        inner()
      }
    },
    modifier = modifier
      .fillMaxWidth()
      .focusRequester(field)
      .onFocusChanged {
        if (focused && !it.isFocused) editing = false
        focused = it.isFocused
      }
      .background(Palette.ink800, shape)
      .border(2.dp, if (focused) Palette.paper else Palette.line, shape),
  )
}
