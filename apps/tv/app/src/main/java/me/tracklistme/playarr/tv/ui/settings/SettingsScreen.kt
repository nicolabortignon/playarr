package me.tracklistme.playarr.tv.ui.settings

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.tv.material3.ListItem
import androidx.tv.material3.ListItemDefaults
import androidx.tv.material3.Switch
import androidx.tv.material3.Text
import me.tracklistme.playarr.api.Api
import me.tracklistme.playarr.player.StreamQuality
import me.tracklistme.playarr.tv.playarr
import me.tracklistme.playarr.tv.playback.PlaybackSettings
import me.tracklistme.playarr.tv.ui.common.Load
import me.tracklistme.playarr.tv.ui.common.Margins
import me.tracklistme.playarr.tv.ui.common.rememberLoad
import me.tracklistme.playarr.tv.ui.theme.Palette
import me.tracklistme.playarr.tv.ui.theme.Type

/**
 * Settings on the TV (plan 9 §5): playback, accounts, the server and about. Admin settings stay on the phone and the
 * web: a TV is shared, and organizing sources and accounts belongs to a person's own device.
 */
@Composable
fun SettingsScreen(onAddAccount: () -> Unit, extra: LazyListScope.() -> Unit = {}) {
  val app = LocalContext.current.playarr
  val settings by app.playback.values.collectAsStateWithLifecycle()
  val state by app.store.current.collectAsStateWithLifecycle()
  val server by rememberLoad { it.send(Api.Server.info()) }
  val version = remember(app) { runCatching { app.packageManager.getPackageInfo(app.packageName, 0).versionName }.getOrNull() ?: "" }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = Margins.Horizontal, end = Margins.Horizontal, top = Margins.Vertical, bottom = 48.dp)) {
    item { Text("Settings", style = Type.pageTitle) }

    section("Playback")
    item {
      Choice("Quality", qualityLabel(settings.quality), "High and Normal are the server’s AAC streams; Original is lossless.") {
        app.playback.update { it.copy(quality = next(StreamQuality.entries, it.quality)) }
      }
    }
    item {
      Choice("Transitions", if (settings.transitions == PlaybackSettings.Transitions.Dj) "DJ mix" else "Off (gapless)", "DJ mix joins songs with the server’s mixes, on the beat.") {
        app.playback.update { it.copy(transitions = next(PlaybackSettings.Transitions.entries, it.transitions)) }
      }
    }
    item { Toggle("Even out the volume", "Every song at the same loudness.", settings.evenVolume) { v -> app.playback.update { it.copy(evenVolume = v) } } }
    item { Toggle("Keep playing when the queue ends", "Similar songs follow the last one.", settings.autoplay) { v -> app.playback.update { it.copy(autoplay = v) } } }
    item { Toggle("Count what this TV plays", "Songs heard here go into the listening history.", settings.recordPlays) { v -> app.playback.update { it.copy(recordPlays = v) } } }

    extra()

    section("Accounts")
    val current = state.account
    val serverRecord = state.server
    current?.let { item { Choice("Listening as", it.name, "Each account has its own history, favorites and mixes.") {} } }
    serverRecord?.accounts?.filter { it.id != current?.id }?.forEach { other ->
      item(key = "acct${other.id}") { Choice("Listen as ${other.name}", "", null) { app.store.switchTo(serverRecord.id, other.id) } }
    }
    item { Choice("Add an account", "", "Sign in another person, with a code on their phone.", onAddAccount) }
    if (current != null && serverRecord != null) {
      item { Choice("Sign out ${current.name}", "", "From this TV only.") { app.store.signedOut(serverRecord.id, current.id) } }
    }

    section("Server")
    item {
      val info = (server as? Load.Done)?.value
      Choice(info?.name ?: serverRecord?.name ?: "Server", serverRecord?.baseUrl ?: "", info?.let { "Playarr ${it.version}" }) {}
    }
    item { Choice("Another server", "", "Connect to another Playarr; this one stays signed in.", onAddAccount) }

    section("About")
    item { Choice("Playarr for TV", version, "Admin settings, sources and accounts are on the phone and the web.") {} }
  }
}

private fun LazyListScope.section(title: String) {
  item(key = "section:$title") { Text(title.uppercase(), style = Type.kicker, modifier = Modifier.padding(top = 28.dp, bottom = 8.dp)) }
}

private fun qualityLabel(q: StreamQuality) = when (q) {
  StreamQuality.High -> "High (256 kbps)"
  StreamQuality.Normal -> "Normal (128 kbps)"
  StreamQuality.Original -> "Original (lossless)"
}

private fun <T> next(all: List<T>, current: T): T = all[(all.indexOf(current) + 1) % all.size]

/** A setting whose OK moves to its next value (or does what it says). */
@Composable
fun Choice(title: String, value: String, detail: String?, onClick: () -> Unit) {
  ListItem(
    selected = false,
    onClick = onClick,
    headlineContent = { Text(title, style = Type.rowTitle) },
    supportingContent = detail?.let { { Text(it, style = Type.rowDetail) } },
    trailingContent = { Text(value, style = Type.meta) },
    colors = ListItemDefaults.colors(containerColor = Palette.ink900),
  )
}

@Composable
fun Toggle(title: String, detail: String, checked: Boolean, onChange: (Boolean) -> Unit) {
  ListItem(
    selected = false,
    onClick = { onChange(!checked) },
    headlineContent = { Text(title, style = Type.rowTitle) },
    supportingContent = { Text(detail, style = Type.rowDetail) },
    trailingContent = { Switch(checked = checked, onCheckedChange = null) },
    colors = ListItemDefaults.colors(containerColor = Palette.ink900),
  )
  Spacer(Modifier.height(2.dp))
}
