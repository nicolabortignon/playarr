package me.tracklistme.playarr.tv.ui.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigatorTests {
  @Test fun everyRouteSurvivesItsLine() {
    val routes = listOf(
      Route.Home, Route.Search, Route.Library, Route.Discover, Route.Settings, Route.NowPlaying, Route.Requests,
      Route.Album(12), Route.Artist(3), Route.Playlist(7), Route.Mix("daily:2"),
      Route.DiscoverArtist("b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d", "Ada: Moreau"),
    )
    for (route in routes) assertEquals(route, Route.decode(route.encode()))
  }

  @Test fun anUnknownLineOpensHome() {
    assertEquals(Route.Home, Route.decode("album:twelve"))
    assertEquals(Route.Home, Route.decode("somewhere"))
  }

  @Test fun pagesBelongToTheirSection() {
    assertEquals(Route.Library, Route.Album(1).section)
    assertEquals(Route.Home, Route.Mix("x").section)
    assertEquals(Route.Discover, Route.Requests.section)
  }

  @Test fun backGoesUpWithinASectionAndARailSectionStartsAfresh() {
    val nav = Navigator(listOf(Route.Library))
    nav.go(Route.Album(1))
    nav.go(Route.Album(1))
    nav.go(Route.Artist(2))
    assertTrue(nav.back())
    assertEquals(Route.Album(1), nav.current)
    nav.section(Route.Search)
    assertEquals(Route.Search, nav.current)
    assertFalse(nav.canGoBack)
  }

  @Test fun nowPlayingOpensOnTopOfThePage() {
    val nav = Navigator(listOf(Route.Album(4)))
    nav.section(Route.NowPlaying)
    nav.back()
    assertEquals(Route.Album(4), nav.current)
  }
}
