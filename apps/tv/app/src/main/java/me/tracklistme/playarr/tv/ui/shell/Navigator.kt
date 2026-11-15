package me.tracklistme.playarr.tv.ui.shell

import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.staticCompositionLocalOf

/** Where the app is. Each saves as a line of text, so the page survives the TV reclaiming the app in the background. */
sealed interface Route {
  /** The rail's section it belongs to. */
  val section: Route get() = this

  data object Home : Route
  data object Search : Route
  data object Library : Route
  data object Discover : Route
  data object Settings : Route
  data object NowPlaying : Route
  data class Album(val id: Int) : Route { override val section get() = Library }
  data class Artist(val id: Int) : Route { override val section get() = Library }
  data class Playlist(val id: Int) : Route { override val section get() = Library }
  data class Mix(val key: String) : Route { override val section get() = Home }
  data class DiscoverArtist(val mbid: String, val name: String) : Route { override val section get() = Discover }
  data object Requests : Route { override val section get() = Discover }

  fun encode(): String = when (this) {
    is Album -> "album:$id"
    is Artist -> "artist:$id"
    is Playlist -> "playlist:$id"
    is Mix -> "mix:$key"
    is DiscoverArtist -> "discover-artist:$mbid\n$name"
    else -> toString()
  }

  companion object {
    fun decode(line: String): Route {
      // Spelled out, not a list of the objects: a companion's list of its interface's objects can be read before
      // they exist (class initialization order), and hold nulls.
      when (line) {
        "Home" -> return Home
        "Search" -> return Search
        "Library" -> return Library
        "Discover" -> return Discover
        "Settings" -> return Settings
        "NowPlaying" -> return NowPlaying
        "Requests" -> return Requests
      }
      val (kind, rest) = line.split(':', limit = 2).let { it[0] to it.getOrElse(1) { "" } }
      return when (kind) {
        "album" -> rest.toIntOrNull()?.let(::Album)
        "artist" -> rest.toIntOrNull()?.let(::Artist)
        "playlist" -> rest.toIntOrNull()?.let(::Playlist)
        "mix" -> Mix(rest)
        "discover-artist" -> rest.split('\n', limit = 2).let { DiscoverArtist(it[0], it.getOrElse(1) { "" }) }
        else -> null
      } ?: Home
    }
  }
}

/** The pages opened, newest last. A rail section starts afresh; Back goes up one page, never out of the section. */
class Navigator(initial: List<Route>) {
  private val stack = mutableStateListOf<Route>().apply { addAll(initial.ifEmpty { listOf(Route.Home) }) }

  val current: Route get() = stack.last()
  val canGoBack: Boolean get() = stack.size > 1

  fun go(route: Route) {
    if (route != current) stack.add(route)
  }

  /** A section from the rail: its page alone (Now Playing stays on top of where you were). */
  fun section(route: Route) {
    if (route == Route.NowPlaying) return go(route)
    stack.clear()
    stack.add(route)
  }

  fun back(): Boolean {
    if (!canGoBack) return false
    stack.removeAt(stack.lastIndex)
    return true
  }

  companion object {
    val Saver: Saver<Navigator, Any> = listSaver(save = { nav -> nav.stack.map { it.encode() } }, restore = { lines -> Navigator(lines.map(Route::decode)) })
  }
}

val LocalNavigator = staticCompositionLocalOf<Navigator> { error("No navigator") }

@Composable
fun nav(): Navigator = LocalNavigator.current
