package me.tracklistme.playarr.tv.ui.shell

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.ui.draw.alpha
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import kotlinx.coroutines.delay
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.tv.material3.DrawerValue
import androidx.tv.material3.Icon
import androidx.tv.material3.NavigationDrawer
import androidx.tv.material3.NavigationDrawerItem
import androidx.tv.material3.NavigationDrawerScope
import androidx.tv.material3.Text
import me.tracklistme.playarr.api.AccountRecord
import me.tracklistme.playarr.api.Api
import me.tracklistme.playarr.tv.playarr
import me.tracklistme.playarr.tv.ui.common.Load
import me.tracklistme.playarr.tv.ui.common.TvIcons
import me.tracklistme.playarr.tv.ui.common.rememberLoad
import me.tracklistme.playarr.tv.ui.discover.DiscoverArtistScreen
import me.tracklistme.playarr.tv.ui.discover.DiscoverScreen
import me.tracklistme.playarr.tv.ui.discover.LocalAccount
import me.tracklistme.playarr.tv.ui.discover.RequestsScreen
import me.tracklistme.playarr.tv.ui.home.HomeScreen
import me.tracklistme.playarr.tv.ui.library.AlbumScreen
import me.tracklistme.playarr.tv.ui.library.ArtistScreen
import me.tracklistme.playarr.tv.ui.library.LibraryScreen
import me.tracklistme.playarr.tv.ui.library.MixScreen
import me.tracklistme.playarr.tv.ui.library.PlaylistScreen
import me.tracklistme.playarr.tv.ui.nowplaying.NowPlayingScreen
import me.tracklistme.playarr.tv.ui.search.SearchScreen
import me.tracklistme.playarr.tv.ui.settings.SettingsScreen
import me.tracklistme.playarr.tv.ui.theme.Palette
import me.tracklistme.playarr.tv.ui.theme.Type

/**
 * The ten-foot app (plan 9 §5): a side rail with the account, Home, Search, Library, Discover, Now Playing while
 * something plays, and Settings; the page on the right. Back goes up a page, and from a section's own page to the rail
 * (then out of the app, as Android TV expects). The pages opened survive the TV reclaiming the app.
 */
@Composable
fun Shell(account: AccountRecord, onAddAccount: () -> Unit, opening: Route? = null) {
  val nav = rememberSaveable(account.id, saver = Navigator.Saver) { Navigator(listOf(Route.Home)) }
  val app = LocalContext.current.playarr
  val now by app.player.current.collectAsStateWithLifecycle()
  val me by rememberLoad(account.id) { it.send(Api.Auth.me()) }
  // A page asked for from outside while the app runs.
  LaunchedEffect(opening) { opening?.let { if (it == it.section) nav.section(it) else nav.go(it) } }
  BackHandler(enabled = nav.canGoBack) { nav.back() }
  val immersive = remember { mutableStateOf(false) }
  val cover by animateFloatAsState(if (immersive.value) 1f else 0f, tween(1200), label = "rail cover")
  CompositionLocalProvider(LocalNavigator provides nav, LocalAccount provides (me as? Load.Done)?.value, LocalImmersive provides immersive) {
    Box(Modifier.fillMaxSize()) {
      NavigationDrawer(
        drawerContent = { value ->
          Column(Modifier.fillMaxHeight().background(Palette.ink950).padding(12.dp).selectableGroup()) {
            RailItem(Icons.Filled.Person, account.name, selected = false, value = value) { nav.section(Route.Settings) }
            Spacer(Modifier.height(16.dp))
            RailItem(Icons.Filled.Home, "Home", nav.current.section == Route.Home, value) { nav.section(Route.Home) }
            RailItem(Icons.Filled.Search, "Search", nav.current.section == Route.Search, value) { nav.section(Route.Search) }
            RailItem(TvIcons.Library, "Library", nav.current.section == Route.Library, value) { nav.section(Route.Library) }
            RailItem(TvIcons.Discover, "Discover", nav.current.section == Route.Discover, value) { nav.section(Route.Discover) }
            if (now.track != null) RailItem(TvIcons.NowPlaying, "Now Playing", nav.current == Route.NowPlaying, value) { nav.section(Route.NowPlaying) }
            Spacer(Modifier.weight(1f))
            RailItem(Icons.Filled.Settings, "Settings", nav.current.section == Route.Settings, value) { nav.section(Route.Settings) }
          }
        },
      ) {
        // Each page opens with the focus in it, not on the rail: where the page puts it (Play, the search field), else
        // its first item.
        val content = remember { FocusRequester() }
        var inContent by remember { mutableStateOf(false) }
        LaunchedEffect(nav.current) {
          delay(500)
          if (!inContent) runCatching { content.requestFocus() }
        }
        Box(Modifier.fillMaxSize().background(Palette.ink900).focusRequester(content).onFocusChanged { inContent = it.hasFocus }) {
          when (val route = nav.current) {
            Route.Home -> HomeScreen(account.name)
            Route.Search -> SearchScreen()
            Route.Library -> LibraryScreen()
            Route.Discover -> DiscoverScreen()
            Route.Settings -> SettingsScreen(onAddAccount)
            Route.NowPlaying -> NowPlayingScreen()
            Route.Requests -> RequestsScreen()
            is Route.Album -> AlbumScreen(route.id)
            is Route.Artist -> ArtistScreen(route.id)
            is Route.Playlist -> PlaylistScreen(route.id)
            is Route.Mix -> MixScreen(route.key)
            is Route.DiscoverArtist -> DiscoverArtistScreen(route.mbid, route.name)
          }
        }
      }
      // A page shown alone (Now Playing's art mode) covers the rail.
      if (cover > 0f) Box(Modifier.fillMaxHeight().width(RailWidth).alpha(cover).background(Palette.ink950))
    }
  }
}

/** The closed rail's width: its items and padding. */
private val RailWidth = 80.dp

/** Set by a page that wants the screen to itself: the rail is covered while it's true. */
val LocalImmersive = staticCompositionLocalOf<MutableState<Boolean>> { mutableStateOf(false) }

@Composable
private fun NavigationDrawerScope.RailItem(icon: ImageVector, label: String, selected: Boolean, value: DrawerValue, onClick: () -> Unit) {
  NavigationDrawerItem(
    selected = selected,
    onClick = onClick,
    leadingContent = { Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp)) },
    modifier = Modifier.width(if (value == DrawerValue.Open) 220.dp else 56.dp),
  ) { Text(label, style = Type.label, maxLines = 1, overflow = TextOverflow.Ellipsis) }
}
