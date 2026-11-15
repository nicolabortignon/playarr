package me.tracklistme.playarr.tv.ui.connect

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Button
import androidx.tv.material3.ListItem
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import java.net.URI
import me.tracklistme.playarr.tv.ui.theme.Palette
import me.tracklistme.playarr.tv.ui.theme.Type

/**
 * Finding the server and signing in from the sofa. `onCancel`: back to listening, when someone already is; `onSignedIn`
 * once a code is approved.
 */
@Composable
fun ConnectScreen(onSignedIn: () -> Unit, onCancel: (() -> Unit)? = null, model: ConnectModel = viewModel()) {
  val step by model.current.collectAsStateWithLifecycle()
  LaunchedEffect(step) {
    if (step is ConnectModel.Step.SignedIn) {
      model.back()
      onSignedIn()
    }
  }
  val servers by model.servers.collectAsStateWithLifecycle()
  BackHandler(enabled = step !is ConnectModel.Step.Finding || onCancel != null) {
    if (step is ConnectModel.Step.Finding) onCancel?.invoke() else model.back()
  }
  Box(Modifier.fillMaxSize().background(Palette.ink900).padding(horizontal = 58.dp, vertical = 40.dp)) {
    when (val s = step) {
      is ConnectModel.Step.Finding -> Finding(servers, s.problem, model::choose, model::type)
      is ConnectModel.Step.Connecting -> Message("Connecting", "Asking ${s.baseUrl}…")
      is ConnectModel.Step.NeedsSetup -> Message(
        s.server.name,
        "Nobody has set up this server yet. Open ${s.baseUrl} on a phone or computer at home, set it up, then come back.",
        action = "Choose another server" to model::back,
      )
      is ConnectModel.Step.Code -> Code(s)
      ConnectModel.Step.SignedIn -> Unit
    }
  }
}

@Composable
private fun Finding(
  servers: List<me.tracklistme.playarr.api.DiscoveredServer>,
  problem: String?,
  choose: (me.tracklistme.playarr.api.DiscoveredServer) -> Unit,
  type: (String) -> Unit,
) {
  var address by rememberSaveable { mutableStateOf("") }
  val first = remember { FocusRequester() }
  Row(horizontalArrangement = Arrangement.spacedBy(64.dp)) {
    Column(Modifier.weight(1f)) {
      Text("PLAYARR", style = Type.kicker)
      Spacer(Modifier.height(8.dp))
      Text("Choose your server", style = Type.pageTitle)
      Spacer(Modifier.height(12.dp))
      Text("Servers on this network appear here. Or type the address you use on your phone.", style = Type.small)
      problem?.let {
        Spacer(Modifier.height(16.dp))
        Text(it, style = Type.small.copy(color = Palette.danger))
      }
    }
    Column(Modifier.weight(1f)) {
      if (servers.isEmpty()) {
        Text("Looking on this network…", style = Type.small)
      } else {
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.height(260.dp)) {
          items(servers, key = { it.id }) { server ->
            ListItem(
              selected = false,
              onClick = { choose(server) },
              headlineContent = { Text(server.name, style = Type.body) },
              supportingContent = { Text(URI(server.baseUrl).authority ?: server.baseUrl, style = Type.meta) },
              modifier = if (server == servers.first()) Modifier.focusRequester(first) else Modifier,
            )
          }
        }
        LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
      }
      Spacer(Modifier.height(24.dp))
      Text("ADDRESS", style = Type.kicker)
      Spacer(Modifier.height(8.dp))
      AddressField(address, { address = it }, onDone = { type(address) })
      Spacer(Modifier.height(16.dp))
      OutlinedButton(onClick = { type(address) }, enabled = address.isNotBlank()) { Text("Connect", style = Type.body) }
    }
  }
}

@Composable
private fun AddressField(value: String, onChange: (String) -> Unit, onDone: () -> Unit) {
  var focused by remember { mutableStateOf(false) }
  BasicTextField(
    value = value,
    onValueChange = onChange,
    singleLine = true,
    textStyle = Type.body,
    cursorBrush = SolidColor(Palette.accent),
    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
    keyboardActions = KeyboardActions(onGo = { onDone() }),
    decorationBox = { inner ->
      Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
        if (value.isEmpty()) Text("192.168.1.103:4000 or music.example.com", style = Type.body.copy(color = Palette.muted))
        inner()
      }
    },
    modifier = Modifier
      .fillMaxWidth()
      .onFocusChanged { focused = it.isFocused }
      .background(Palette.ink800, RoundedCornerShape(12.dp))
      .border(2.dp, if (focused) Palette.paper else Palette.line, RoundedCornerShape(12.dp)),
  )
}

/** The code, its QR code, and where to type it: approved on a phone or the web, the TV signs in by itself. */
@Composable
private fun Code(step: ConnectModel.Step.Code) {
  val code = step.code.code
  val link = URI(step.code.verifyUrl).let { "${it.authority}${it.path}" }
  Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(64.dp), modifier = Modifier.fillMaxSize()) {
    Column(Modifier.weight(1f)) {
      Text(step.server.name.uppercase(), style = Type.kicker)
      Spacer(Modifier.height(8.dp))
      Text("Sign in with your phone", style = Type.pageTitle)
      Spacer(Modifier.height(16.dp))
      Text("Scan the code with your phone’s camera, or open $link on a phone or computer and type:", style = Type.small)
      Spacer(Modifier.height(24.dp))
      Text("${code.take(4)} ${code.drop(4)}", style = Type.code)
      Spacer(Modifier.height(24.dp))
      Text("Sign in there as whoever will listen here. This screen moves on by itself.", style = Type.meta)
    }
    QrCode(step.code.verifyUrl, size = 220.dp, contentDescription = "QR code for $link")
  }
}

@Composable
private fun Message(title: String, text: String, action: Pair<String, () -> Unit>? = null) {
  val focus = remember { FocusRequester() }
  Column(Modifier.width(640.dp).padding(top = 80.dp)) {
    Text(title, style = Type.pageTitle)
    Spacer(Modifier.height(16.dp))
    Text(text, style = Type.small)
    action?.let { (label, onClick) ->
      Spacer(Modifier.height(32.dp))
      Button(onClick = onClick, modifier = Modifier.focusRequester(focus)) { Text(label, style = Type.body) }
      LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    }
  }
}
