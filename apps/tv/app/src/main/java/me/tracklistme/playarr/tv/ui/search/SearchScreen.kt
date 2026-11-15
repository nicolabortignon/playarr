package me.tracklistme.playarr.tv.ui.search

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import me.tracklistme.playarr.api.Api
import me.tracklistme.playarr.api.SearchResults
import me.tracklistme.playarr.tv.playarr
import me.tracklistme.playarr.tv.ui.common.CoverCard
import me.tracklistme.playarr.tv.ui.common.count
import me.tracklistme.playarr.tv.ui.common.Margins
import me.tracklistme.playarr.tv.ui.common.SearchEntry
import me.tracklistme.playarr.tv.ui.common.TrackRow
import me.tracklistme.playarr.tv.ui.common.cardRow
import me.tracklistme.playarr.tv.ui.shell.Route
import me.tracklistme.playarr.tv.ui.shell.nav
import me.tracklistme.playarr.tv.ui.theme.Palette
import me.tracklistme.playarr.tv.ui.theme.Type

/** Search the library as you type, results as the web shows them: artists, albums, then songs. */
@Composable
fun SearchScreen() {
  var query by rememberSaveable { mutableStateOf("") }
  var results by remember { mutableStateOf<SearchResults?>(null) }
  var error by remember { mutableStateOf<String?>(null) }
  val app = LocalContext.current.playarr
  val now by app.player.current.collectAsStateWithLifecycle()
  val nav = nav()
  val scope = rememberCoroutineScope()
  val focus = remember { FocusRequester() }
  LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
  LaunchedEffect(query) {
    if (query.isBlank()) {
      results = null
      return@LaunchedEffect
    }
    // Typing on a remote is slow: a quarter of a second after the last letter.
    delay(250)
    val client = app.client() ?: return@LaunchedEffect
    runCatching { client.send(Api.Search.library(query.trim())) }
      .onSuccess { results = it; error = null }
      .onFailure { error = it.message }
  }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = Margins.Horizontal, end = Margins.Horizontal, top = Margins.Vertical, bottom = 48.dp)) {
    item(key = "entry") {
      Text("Search", style = Type.pageTitle)
      Spacer(Modifier.height(12.dp))
      SearchEntry(query, { query = it }, "Artists, albums and songs", focus = focus)
      error?.let { Text(it, style = Type.small.copy(color = Palette.danger), modifier = Modifier.padding(top = 8.dp)) }
    }
    val found = results
    if (found != null) {
      if (found.artists.isEmpty() && found.albums.isEmpty() && found.tracks.isEmpty()) {
        item(key = "none") { Text("Nothing in the library matches “$query”.", style = Type.small, modifier = Modifier.padding(top = 24.dp)) }
      }
      if (found.near == true) item(key = "near") { Text("Nothing exactly like that: these are close.", style = Type.meta, modifier = Modifier.padding(top = 12.dp)) }
      cardRow("Artists", found.artists, key = { "ar${it.id}" }) { artist ->
        CoverCard(artist.name, count(artist.albumCount, "album"), artist.imageUrl, round = true) { nav.go(Route.Artist(artist.id)) }
      }
      cardRow("Albums", found.albums, key = { "al${it.id}" }) { album ->
        CoverCard(album.title, album.artistName, album.coverUrl, album.coverColor) { nav.go(Route.Album(album.id)) }
      }
      if (found.tracks.isNotEmpty()) item(key = "songs") { Text("Songs", style = Type.sectionTitle, modifier = Modifier.padding(top = 20.dp, bottom = 8.dp)) }
      itemsIndexed(found.tracks, key = { _, t -> "t${t.id}" }) { index, track ->
        TrackRow(track, null, now.track?.id == track.id, showArtist = true, onClick = { scope.launch { app.player.play(found.tracks, index) } })
      }
    }
  }
}
