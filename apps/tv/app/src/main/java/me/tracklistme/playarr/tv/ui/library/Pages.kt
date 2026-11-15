package me.tracklistme.playarr.tv.ui.library

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import kotlinx.coroutines.launch
import me.tracklistme.playarr.api.Api
import me.tracklistme.playarr.api.Track
import me.tracklistme.playarr.tv.playarr
import me.tracklistme.playarr.tv.ui.common.Art
import me.tracklistme.playarr.tv.ui.common.CardWidth
import me.tracklistme.playarr.tv.ui.common.CoverCard
import me.tracklistme.playarr.tv.ui.common.count
import me.tracklistme.playarr.tv.ui.common.Loaded
import me.tracklistme.playarr.tv.ui.common.Margins
import me.tracklistme.playarr.tv.ui.common.PageHeader
import me.tracklistme.playarr.tv.ui.common.TrackRow
import me.tracklistme.playarr.tv.ui.common.cardRow
import me.tracklistme.playarr.tv.ui.common.length
import me.tracklistme.playarr.tv.ui.common.rememberLoad
import me.tracklistme.playarr.tv.ui.shell.Route
import me.tracklistme.playarr.tv.ui.shell.nav
import me.tracklistme.playarr.tv.ui.theme.Type

private val pagePadding = PaddingValues(start = Margins.Horizontal, end = Margins.Horizontal, top = Margins.Vertical, bottom = 48.dp)
private val headerArt = 200.dp

/** A page of songs: the header, then the songs, OK on one playing the page from it. Play takes the first focus. */
@Composable
private fun SongsPage(
  kicker: String,
  title: String,
  facts: String?,
  art: (@Composable () -> Unit)?,
  tracks: List<Track>,
  showArtist: Boolean,
  numbered: Boolean = true,
  after: LazyListScope.() -> Unit = {},
) {
  val app = LocalContext.current.playarr
  val now by app.player.current.collectAsStateWithLifecycle()
  val scope = rememberCoroutineScope()
  val playFocus = remember { FocusRequester() }
  LaunchedEffect(title) { runCatching { playFocus.requestFocus() } }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = pagePadding) {
    item(key = "header") {
      PageHeader(
        kicker = kicker,
        title = title,
        facts = facts,
        art = art,
        onPlay = if (tracks.isEmpty()) null else ({ scope.launch { app.player.play(tracks) } }),
        onShuffle = if (tracks.size < 2) null else ({ scope.launch { app.player.shuffle(tracks) } }),
        playFocus = playFocus,
      )
      Spacer(Modifier.height(24.dp))
    }
    itemsIndexed(tracks, key = { index, t -> "$index:${t.recordingId}" }) { index, track ->
      TrackRow(track, if (numbered) track.trackNumber else index + 1, now.track?.id == track.id, showArtist, onClick = { scope.launch { app.player.play(tracks, index) } })
    }
    after()
  }
}

@Composable
fun AlbumScreen(id: Int) {
  val load by rememberLoad(id) { it.send(Api.Library.album(id)) }
  val nav = nav()
  Loaded(load) { album ->
    val facts = listOfNotNull(album.artistName, album.year?.toString(), count(album.tracks.size, "song"), length(album.duration)).joinToString(" · ")
    SongsPage(
      kicker = album.albumType,
      title = album.title,
      facts = facts,
      art = { Art(album.coverUrl, headerArt, album.coverColor, Modifier.size(headerArt)) },
      tracks = album.tracks,
      showArtist = album.tracks.any { it.artistId != album.artistId },
      after = {
        item(key = "artist") {
          Spacer(Modifier.height(24.dp))
          OutlinedButton(onClick = { nav.go(Route.Artist(album.artistId)) }) { Text("More by ${album.artistName}", style = Type.label) }
        }
      },
    )
  }
}

@Composable
fun ArtistScreen(id: Int) {
  val load by rememberLoad(id) { client -> client.send(Api.Library.artist(id)) to client.send(Api.Library.artistTracks(id)) }
  val nav = nav()
  val app = LocalContext.current.playarr
  val scope = rememberCoroutineScope()
  val playFocus = remember { FocusRequester() }
  Loaded(load) { (artist, tracks) ->
    LaunchedEffect(artist.id) { runCatching { playFocus.requestFocus() } }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = pagePadding) {
      item(key = "header") {
        PageHeader(
          kicker = "Artist",
          title = artist.name,
          facts = "${count(artist.albumCount, "album")} · ${count(artist.trackCount, "song")}",
          art = { Art(artist.imageUrl, headerArt, null, Modifier.size(headerArt), CircleShape) },
          onPlay = if (tracks.isEmpty()) null else ({ scope.launch { app.player.play(tracks) } }),
          onShuffle = if (tracks.size < 2) null else ({ scope.launch { app.player.shuffle(tracks) } }),
          playFocus = playFocus,
        )
      }
      cardRow("Albums", artist.albums, key = { it.id }) { album ->
        CoverCard(album.title, album.year?.toString(), album.coverUrl, album.coverColor, CardWidth.Cover) { nav.go(Route.Album(album.id)) }
      }
    }
  }
}

@Composable
fun PlaylistScreen(id: Int) {
  val load by rememberLoad(id) { it.send(Api.Playlists.get(id)) }
  Loaded(load) { playlist ->
    val tracks = playlist.items.mapNotNull { it.track }
    SongsPage(
      kicker = if (playlist.mine) "Playlist" else "Playlist by ${playlist.owner}",
      title = playlist.name,
      facts = listOfNotNull(playlist.description.takeIf { it.isNotBlank() }, count(tracks.size, "song"), length(playlist.duration)).joinToString(" · "),
      art = { Art(playlist.cover.url, headerArt, null, Modifier.size(headerArt)) },
      tracks = tracks,
      showArtist = true,
      numbered = false,
    )
  }
}

@Composable
fun MixScreen(key: String) {
  val load by rememberLoad(key) { it.send(Api.Mixes.get(key)) }
  Loaded(load) { mix ->
    SongsPage(
      kicker = mix.subtitle,
      title = mix.title,
      facts = listOf(mix.description, count(mix.tracks.size, "song"), length(mix.duration)).filter { it.isNotBlank() }.joinToString(" · "),
      art = mix.covers.firstOrNull()?.let { cover -> { Art(cover, headerArt, null, Modifier.size(headerArt)) } },
      tracks = mix.tracks,
      showArtist = true,
      numbered = false,
    )
  }
}
