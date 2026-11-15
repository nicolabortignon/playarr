package me.tracklistme.playarr.tv.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import me.tracklistme.playarr.api.Album
import me.tracklistme.playarr.api.AccountRecord
import me.tracklistme.playarr.tv.playarr
import me.tracklistme.playarr.tv.ui.theme.Palette
import me.tracklistme.playarr.tv.ui.theme.Type

/**
 * Step 2's proof that the TV talks to the server: the library's albums, newest first, with who's listening and the
 * accounts to switch to. Step 5 replaces it with Home, Search, Library and Settings on a side rail.
 */
@Composable
fun HomeScreen(account: AccountRecord, others: List<AccountRecord>, onSwitch: (AccountRecord) -> Unit, onAddAccount: () -> Unit, onSignOut: () -> Unit) {
  val model: AlbumsModel = viewModel(key = "albums-${account.id}")
  val state by model.current.collectAsStateWithLifecycle()
  Column(Modifier.fillMaxSize().background(Palette.ink900).padding(horizontal = 58.dp, vertical = 28.dp)) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
      Column(Modifier.weight(1f)) {
        Text("LISTENING AS ${account.name.uppercase()}", style = Type.kicker)
        Text("Albums", style = Type.pageTitle)
      }
      state.total?.let { Text("$it", style = Type.meta) }
      others.forEach { other -> OutlinedButton(onClick = { onSwitch(other) }) { Text("Listen as ${other.name}", style = Type.label) } }
      OutlinedButton(onClick = onAddAccount) { Text("Add account", style = Type.label) }
      OutlinedButton(onClick = onSignOut) { Text("Sign out", style = Type.label) }
    }
    Spacer(Modifier.height(20.dp))
    state.error?.let { Text(it, style = Type.small.copy(color = Palette.danger)) }
    LazyVerticalGrid(
      columns = GridCells.Adaptive(150.dp),
      contentPadding = PaddingValues(vertical = 12.dp),
      horizontalArrangement = Arrangement.spacedBy(24.dp),
      verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
      itemsIndexed(state.albums, key = { _, album -> album.id }) { index, album ->
        if (index >= state.albums.size - 12) model.more()
        AlbumCard(album)
      }
    }
  }
}

/** A cover that grows on focus, with the title and artist under it. The cover is asked for at the size it's shown. */
@Composable
private fun AlbumCard(album: Album) {
  val media = LocalContext.current.playarr.media()
  val pixels = with(LocalDensity.current) { 150.dp.roundToPx() }
  Column {
    Card(
      onClick = {},
      shape = CardDefaults.shape(RoundedCornerShape(4.dp)),
      scale = CardDefaults.scale(focusedScale = 1.08f),
      modifier = Modifier.fillMaxWidth().aspectRatio(1f),
    ) {
      AsyncImage(
        model = media?.art(album.coverUrl, pixels),
        contentDescription = null,
        contentScale = ContentScale.Crop,
        modifier = Modifier.fillMaxSize().background(album.coverColor?.let(::parse) ?: Palette.ink800),
      )
    }
    Spacer(Modifier.height(10.dp))
    Text(album.title, style = Type.small.copy(color = Palette.paper), maxLines = 1, overflow = TextOverflow.Ellipsis)
    Text(album.artistName, style = Type.meta, maxLines = 1, overflow = TextOverflow.Ellipsis)
  }
}

/** "#rrggbb" → Color; null when it isn't one. */
private fun parse(hex: String): Color? = hex.removePrefix("#").toLongOrNull(16)?.takeIf { hex.length == 7 }?.let { Color(0xFF000000 or it) }
