package me.tracklistme.playarr.tv.ui.library

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Tab
import androidx.tv.material3.TabRow
import androidx.tv.material3.Text
import kotlinx.coroutines.launch
import me.tracklistme.playarr.api.Api
import me.tracklistme.playarr.api.Track
import me.tracklistme.playarr.tv.playarr
import me.tracklistme.playarr.tv.ui.common.CardWidth
import me.tracklistme.playarr.tv.ui.common.CoverCard
import me.tracklistme.playarr.tv.ui.common.count
import me.tracklistme.playarr.tv.ui.common.Loaded
import me.tracklistme.playarr.tv.ui.common.Margins
import me.tracklistme.playarr.tv.ui.common.TrackRow
import me.tracklistme.playarr.tv.ui.common.rememberLoad
import me.tracklistme.playarr.tv.ui.home.AlbumsModel
import me.tracklistme.playarr.tv.ui.shell.Route
import me.tracklistme.playarr.tv.ui.shell.nav
import me.tracklistme.playarr.tv.ui.theme.Palette
import me.tracklistme.playarr.tv.ui.theme.Type

/** The library: albums (newest first, a page at a time), artists, playlists and favorites. */
@Composable
fun LibraryScreen() {
  var tab by rememberSaveable { mutableIntStateOf(0) }
  Column(Modifier.fillMaxSize().padding(horizontal = Margins.Horizontal, vertical = Margins.Vertical)) {
    Text("Library", style = Type.pageTitle)
    Spacer(Modifier.height(12.dp))
    TabRow(selectedTabIndex = tab) {
      TABS.forEachIndexed { index, title ->
        Tab(selected = index == tab, onFocus = { tab = index }) { Text(title, style = Type.label, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
      }
    }
    Spacer(Modifier.height(16.dp))
    when (tab) {
      0 -> Albums()
      1 -> Artists()
      2 -> Playlists()
      else -> Favorites()
    }
  }
}

private val TABS = listOf("Albums", "Artists", "Playlists", "Favorites")

private val gridPadding = PaddingValues(top = 12.dp, bottom = 32.dp)

@Composable
private fun Albums() {
  val model: AlbumsModel = viewModel()
  val state by model.current.collectAsStateWithLifecycle()
  val nav = nav()
  state.error?.let { Text(it, style = Type.small.copy(color = Palette.danger)) }
  LazyVerticalGrid(GridCells.Adaptive(CardWidth.Cover), contentPadding = gridPadding, horizontalArrangement = Arrangement.spacedBy(24.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
    itemsIndexed(state.albums, key = { _, album -> album.id }) { index, album ->
      if (index >= state.albums.size - 12) model.more()
      CoverCard(album.title, album.artistName, album.coverUrl, album.coverColor) { nav.go(Route.Album(album.id)) }
    }
  }
}

@Composable
private fun Artists() {
  val load by rememberLoad { it.send(Api.Library.artists()) }
  val nav = nav()
  Loaded(load) { artists ->
    LazyVerticalGrid(GridCells.Adaptive(CardWidth.Cover), contentPadding = gridPadding, horizontalArrangement = Arrangement.spacedBy(24.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
      items(artists, key = { it.id }) { artist ->
        CoverCard(artist.name, count(artist.albumCount, "album"), artist.imageUrl, round = true) { nav.go(Route.Artist(artist.id)) }
      }
    }
  }
}

@Composable
private fun Playlists() {
  val load by rememberLoad { it.send(Api.Playlists.list()) }
  val nav = nav()
  Loaded(load) { playlists ->
    if (playlists.isEmpty()) Text("No playlists yet. Make them on your phone or the web.", style = Type.small)
    LazyVerticalGrid(GridCells.Adaptive(CardWidth.Cover), contentPadding = gridPadding, horizontalArrangement = Arrangement.spacedBy(24.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
      items(playlists, key = { it.id }) { playlist ->
        CoverCard(playlist.name, count(playlist.trackCount, "song"), playlist.cover.url) { nav.go(Route.Playlist(playlist.id)) }
      }
    }
  }
}

@Composable
private fun Favorites() {
  val load by rememberLoad { it.send(Api.Favorites.list()) }
  val app = LocalContext.current.playarr
  val now by app.player.current.collectAsStateWithLifecycle()
  val scope = rememberCoroutineScope()
  Loaded(load) { favorites ->
    val tracks = favorites.map { f ->
      Track(f.id, f.recordingId, f.fileId, f.albumId, f.artistId, f.title, f.artistName, f.albumTitle, f.trackNumber, f.discNumber, f.duration, f.explicit, f.format, f.size, f.streamUrl, f.coverUrl, f.coverColor, f.coverAccent)
    }
    if (tracks.isEmpty()) Text("Songs you love on any device show up here.", style = Type.small)
    LazyColumn(contentPadding = gridPadding) {
      itemsIndexed(tracks, key = { _, t -> t.recordingId }) { index, track ->
        TrackRow(track, index + 1, now.track?.id == track.id, showArtist = true, onClick = { scope.launch { app.player.play(tracks, index) } })
      }
    }
  }
}
