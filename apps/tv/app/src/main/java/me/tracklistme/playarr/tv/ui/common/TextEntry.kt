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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ButtonDefaults
import androidx.tv.material3.OutlinedButton
import me.tracklistme.playarr.tv.ui.theme.Palette
import me.tracklistme.playarr.tv.ui.theme.Type

/**
 * A text field for the remote: a button until chosen, so the TV's keyboard doesn't cover the screen as the page
 * opens; OK opens the keyboard (its microphone key, where the remote has one, types by voice), its action key or moving
 * away closes it (the action key also calls `onDone`). `focus` lets the page give the button the first focus.
 */
@Composable
fun TextEntry(
  value: String,
  onChange: (String) -> Unit,
  placeholder: String,
  modifier: Modifier = Modifier,
  focus: FocusRequester? = null,
  icon: ImageVector = Icons.Filled.Search,
  keyboard: KeyboardType = KeyboardType.Text,
  onDone: () -> Unit = {},
) {
  var editing by remember { mutableStateOf(false) }
  var focused by remember { mutableStateOf(false) }
  val field = remember { FocusRequester() }
  val button = focus ?: remember { FocusRequester() }
  // Closed by the keyboard's action key: the field it was goes, so the focus goes back to the button.
  var refocus by remember { mutableStateOf(false) }
  val shape = RoundedCornerShape(12.dp)
  if (!editing) {
    // As wide as the page: it doesn't grow on focus (it would cover what's beside it), it lights up.
    OutlinedButton(
      onClick = { editing = true },
      scale = ButtonDefaults.scale(focusedScale = 1f),
      modifier = modifier.fillMaxWidth().focusRequester(button),
    ) {
      IconLabel(icon, value.ifEmpty { placeholder })
    }
    LaunchedEffect(refocus) {
      if (refocus) runCatching { button.requestFocus() }
      refocus = false
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
    keyboardOptions = KeyboardOptions(keyboardType = keyboard, imeAction = if (keyboard == KeyboardType.Text) ImeAction.Search else ImeAction.Done),
    keyboardActions = KeyboardActions(
      onSearch = { refocus = true; editing = false; onDone() },
      onDone = { refocus = true; editing = false; onDone() },
    ),
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
