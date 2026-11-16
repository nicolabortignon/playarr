package me.tracklistme.playarr.tv.ui.discover

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ListItem
import androidx.tv.material3.ListItemDefaults
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import me.tracklistme.playarr.api.Account
import me.tracklistme.playarr.api.AlbumRef
import me.tracklistme.playarr.api.Api
import me.tracklistme.playarr.api.Availability
import me.tracklistme.playarr.api.AvailabilityState
import me.tracklistme.playarr.api.DiscoverAlbum
import me.tracklistme.playarr.api.DiscoverResults
import me.tracklistme.playarr.api.RequestAccess
import me.tracklistme.playarr.api.RequestApproval
import me.tracklistme.playarr.tv.playarr
import me.tracklistme.playarr.tv.ui.common.Art
import me.tracklistme.playarr.tv.ui.common.CardWidth
import me.tracklistme.playarr.tv.ui.common.CoverCard
import me.tracklistme.playarr.tv.ui.common.Load
import me.tracklistme.playarr.tv.ui.common.Loaded
import me.tracklistme.playarr.tv.ui.common.Margins
import me.tracklistme.playarr.tv.ui.common.TextEntry
import me.tracklistme.playarr.tv.ui.common.cardRow
import me.tracklistme.playarr.tv.ui.common.rememberLoad
import me.tracklistme.playarr.tv.ui.shell.Route
import me.tracklistme.playarr.tv.ui.shell.nav
import me.tracklistme.playarr.tv.ui.theme.Palette
import me.tracklistme.playarr.tv.ui.theme.Type

/** The account listening, as the server knows it (its request access); null until it's known. */
val LocalAccount = staticCompositionLocalOf<Account?> { null }

/** How this account may ask for music: "on" (straight to the server), "ask" (an admin decides), or not at all. */
private fun requestAccess(account: Account?): RequestAccess? = when {
  account == null || !account.canRequest -> null
  else -> account.requestAccess ?: RequestAccess.On
}

private val pagePadding = PaddingValues(start = Margins.Horizontal, end = Margins.Horizontal, top = Margins.Vertical, bottom = 48.dp)

/**
 * Discover on the TV, as on the phone: find any artist or album (MusicBrainz, through the server), see what the
 * library has of it, and, as the account's request access allows, ask for what it hasn't.
 */
@Composable
fun DiscoverScreen() {
  var query by rememberSaveable { mutableStateOf("") }
  var results by remember { mutableStateOf<DiscoverResults?>(null) }
  var error by remember { mutableStateOf<String?>(null) }
  val app = LocalContext.current.playarr
  val nav = nav()
  val access = requestAccess(LocalAccount.current)
  val focus = remember { FocusRequester() }
  LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
  LaunchedEffect(query) {
    if (query.isBlank()) return@LaunchedEffect
    delay(400)
    val client = app.client() ?: return@LaunchedEffect
    runCatching { client.send(Api.Discover.search(query.trim())) }.onSuccess { results = it; error = null }.onFailure { error = it.message }
  }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = pagePadding) {
    item(key = "head") {
      Text("Discover", style = Type.pageTitle)
      Spacer(Modifier.height(12.dp))
      Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        TextEntry(query, { query = it }, "Any artist or album", Modifier.weight(1f), focus)
        if (access != null) OutlinedButton(onClick = { nav.go(Route.Requests) }) { Text("Requests", style = Type.label) }
      }
      error?.let { Text(it, style = Type.small.copy(color = Palette.danger), modifier = Modifier.padding(top = 8.dp)) }
      if (results == null) {
        Spacer(Modifier.height(20.dp))
        Text(
          when (access) {
            RequestAccess.On -> "Find any artist or album, see what the library has of it, and ask for what it hasn’t."
            RequestAccess.Ask -> "Find any artist or album and see what the library has of it. Ask for more, and an admin decides."
            else -> "Find any artist or album, and see what the library has of it."
          },
          style = Type.small,
        )
      }
    }
    val found = results ?: return@LazyColumn
    cardRow("Artists", found.artists, key = { "a${it.mbid}" }) { artist ->
      CoverCard(artist.name, artist.disambiguation ?: artist.genres.firstOrNull(), artist.imageUrl, round = true) { nav.go(Route.DiscoverArtist(artist.mbid, artist.name)) }
    }
    cardRow("Albums", found.albums, key = { "b${it.mbid}" }) { album -> AlbumCard(album, access) }
  }
}

@Composable
fun DiscoverArtistScreen(mbid: String, name: String) {
  val load by rememberLoad(mbid) { it.send(Api.Discover.artist(mbid)) }
  val access = requestAccess(LocalAccount.current)
  val nav = nav()
  val artist = (load as? Load.Done)?.value
  LazyVerticalGrid(
    GridCells.Adaptive(CardWidth.Cover),
    contentPadding = pagePadding,
    horizontalArrangement = Arrangement.spacedBy(24.dp),
    verticalArrangement = Arrangement.spacedBy(24.dp),
    modifier = Modifier.fillMaxSize(),
  ) {
    item(key = "head", span = { GridItemSpan(maxLineSpan) }) {
      Column {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(32.dp)) {
          Art(artist?.imageUrl, 180.dp, null, Modifier.size(180.dp), CircleShape)
          Column {
            Text("ARTIST", style = Type.kicker)
            Text(name, style = Type.pageTitle)
            artist?.genres?.takeIf { it.isNotEmpty() }?.let { Text(it.take(4).joinToString(" · "), style = Type.meta) }
            artist?.artistId?.let { id ->
              Spacer(Modifier.height(12.dp))
              OutlinedButton(onClick = { nav.go(Route.Artist(id)) }) { Text("In your library", style = Type.label) }
            }
          }
        }
        Spacer(Modifier.height(8.dp))
        if (load !is Load.Done) Loaded(load) {}
        artist?.discographyError?.let { Text(it, style = Type.small.copy(color = Palette.danger)) }
      }
    }
    items(artist?.albums.orEmpty(), key = { it.mbid }) { album -> AlbumCard(album, access) }
  }
}

/** What's become of each album asked for on this TV since the app started (the server's answer comes with the next visit). */
private val asked = mutableStateMapOf<String, String>()

/**
 * An album: in the library, it opens there; otherwise OK asks for it (or asks an admin) when the account may, and
 * says how it's going.
 */
@Composable
private fun AlbumCard(album: DiscoverAlbum, access: RequestAccess?) {
  val app = LocalContext.current.playarr
  val nav = nav()
  val scope = rememberCoroutineScope()
  val status = asked[album.mbid] ?: availabilityLabel(album.availability, access)
  CoverCard(album.title, listOfNotNull(album.year?.toString(), status).joinToString(" · "), album.coverUrl) {
    val inLibrary = album.availability.albumId
    when {
      inLibrary != null -> nav.go(Route.Album(inLibrary))
      access == null || album.availability.state != AvailabilityState.None -> Unit
      else -> scope.launch {
        val client = app.client() ?: return@launch
        asked[album.mbid] = "Asking…"
        runCatching { client.send(Api.Requests.request(AlbumRef(mbid = album.mbid, artistName = album.artistName, albumTitle = album.title))) }
          .onSuccess { asked[album.mbid] = if (it.approval == RequestApproval.Waiting) "Waiting for an admin" else "Requested" }
          .onFailure { asked[album.mbid] = it.message ?: "Couldn’t ask" }
      }
    }
  }
}

private fun availabilityLabel(a: Availability, access: RequestAccess?): String? = when (a.state) {
  AvailabilityState.Available -> "In your library"
  AvailabilityState.Partial -> "Some of it"
  AvailabilityState.Searching, AvailabilityState.Waiting -> "Requested"
  AvailabilityState.Downloading -> a.progress?.let { "Downloading ${(it * 100).toInt()}%" } ?: "Downloading"
  AvailabilityState.Importing -> "Importing"
  AvailabilityState.Failed -> a.message ?: "Couldn’t get it"
  else -> when (access) {
    RequestAccess.On -> "Request"
    RequestAccess.Ask -> "Ask for it"
    else -> null
  }
}

/** The albums asked for: this account's (an admin sees everyone's), with how each is going. */
@Composable
fun RequestsScreen() {
  val load by rememberLoad { it.send(Api.Requests.list()) }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = pagePadding) {
    item { Text("Requests", style = Type.pageTitle); Spacer(Modifier.height(16.dp)) }
    item {
      Loaded(load) { requests ->
        if (requests.isEmpty()) Text("Nothing asked for yet. Find an album in Discover and choose it.", style = Type.small)
        Column {
          requests.forEach { r ->
            ListItem(
              selected = false,
              onClick = {},
              headlineContent = { Text(r.title, style = Type.rowTitle) },
              supportingContent = { Text(listOfNotNull(r.artistName, r.askedBy?.joinToString()?.let { "asked by $it" }).joinToString(" · "), style = Type.rowDetail) },
              leadingContent = { Art(r.coverUrl, 56.dp, null, Modifier.size(56.dp)) },
              trailingContent = {
                Text(if (r.approval == RequestApproval.Declined) "Declined" else if (r.approval == RequestApproval.Waiting) "Waiting for an admin" else availabilityLabel(r.availability, null) ?: "", style = Type.meta)
              },
              colors = ListItemDefaults.colors(containerColor = Palette.ink900),
            )
            Spacer(Modifier.width(1.dp))
          }
        }
      }
    }
  }
}
