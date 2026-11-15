package me.tracklistme.playarr.tv.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.Text
import kotlinx.coroutines.launch
import me.tracklistme.playarr.api.AlbumSort
import me.tracklistme.playarr.api.Api
import me.tracklistme.playarr.api.MixSummary
import me.tracklistme.playarr.tv.playarr
import me.tracklistme.playarr.tv.ui.common.Art
import me.tracklistme.playarr.tv.ui.common.CardWidth
import me.tracklistme.playarr.tv.ui.common.CoverCard
import me.tracklistme.playarr.tv.ui.common.Load
import me.tracklistme.playarr.tv.ui.common.Margins
import me.tracklistme.playarr.tv.ui.common.cardRow
import me.tracklistme.playarr.tv.ui.common.rememberLoad
import me.tracklistme.playarr.tv.ui.shell.Route
import me.tracklistme.playarr.tv.ui.shell.nav
import me.tracklistme.playarr.tv.ui.theme.Palette
import me.tracklistme.playarr.tv.ui.theme.Type

/**
 * Home (plan 9 §5): Jump back in (the albums played lately), Made for you (the server's mixes, and Feeling Lucky),
 * and Recently added. Each row is asked for on its own, so a slow one doesn't hold the others up.
 */
@Composable
fun HomeScreen(name: String) {
  val recent by rememberLoad { it.send(Api.Library.recentAlbums()) }
  val mixes by rememberLoad { it.send(Api.Mixes.list()) }
  val added by rememberLoad { it.send(Api.Library.albums(AlbumSort.Added, limit = 24)) }
  val nav = nav()
  val app = LocalContext.current.playarr
  val scope = rememberCoroutineScope()
  val failed = listOf(recent, mixes, added).filterIsInstance<Load.Failed>().firstOrNull()
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = Margins.Horizontal, end = Margins.Horizontal, top = Margins.Vertical, bottom = 48.dp)) {
    item(key = "title") {
      Text("LISTENING AS ${name.uppercase()}", style = Type.kicker)
      Text("Home", style = Type.pageTitle)
      failed?.let { Text(it.message, style = Type.small.copy(color = Palette.danger), modifier = Modifier.padding(top = 8.dp)) }
    }
    cardRow("Jump back in", (recent as? Load.Done)?.value.orEmpty(), key = { "r${it.id}" }) { album ->
      CoverCard(album.title, album.artistName, album.coverUrl, album.coverColor) { nav.go(Route.Album(album.id)) }
    }
    val made = (mixes as? Load.Done)?.value.orEmpty()
    if (made.isNotEmpty()) {
      cardRow("Made for you", listOf<MixSummary?>(null) + made, key = { it?.key ?: "lucky" }) { mix ->
        if (mix == null) {
          MixCard("Feeling Lucky", "Fifteen songs, picked now", null, 30.0) {
            scope.launch {
              val client = app.client() ?: return@launch
              runCatching { client.send(Api.Mixes.lucky()) }.onSuccess { app.player.play(it.tracks) }
            }
          }
        } else {
          MixCard(mix.title, mix.subtitle, mix.covers.firstOrNull(), mix.hue) { nav.go(Route.Mix(mix.key)) }
        }
      }
    }
    cardRow("Recently added", (added as? Load.Done)?.value.orEmpty(), key = { "a${it.id}" }) { album ->
      CoverCard(album.title, album.artistName, album.coverUrl, album.coverColor) { nav.go(Route.Album(album.id)) }
    }
  }
}

/** A mix: its cover washed in its hue, its name on it, the subtitle under. */
@Composable
private fun MixCard(title: String, subtitle: String, cover: String?, hue: Double, onClick: () -> Unit) {
  val tint = Color.hsv((((hue % 360) + 360) % 360).toFloat(), 0.55f, 0.45f)
  Column(Modifier.width(CardWidth.Large)) {
    Card(onClick = onClick, shape = CardDefaults.shape(RoundedCornerShape(6.dp)), scale = CardDefaults.scale(focusedScale = 1.06f), modifier = Modifier.fillMaxWidth().aspectRatio(1f)) {
      Box(Modifier.fillMaxSize().background(tint)) {
        cover?.let { Art(it, CardWidth.Large, null, Modifier.fillMaxSize()) }
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Transparent, tint.copy(alpha = 0.9f)))))
        Text(title, style = Type.sectionTitle, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.align(Alignment.BottomStart).padding(16.dp))
      }
    }
    Spacer(Modifier.height(10.dp))
    Text(subtitle, style = Type.meta, maxLines = 1, overflow = TextOverflow.Ellipsis)
  }
}
