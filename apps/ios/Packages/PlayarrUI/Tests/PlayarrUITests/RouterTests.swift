import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct RouterTests {
  @Test func readsTheWebsPaths() {
    #expect(Route(href: "/albums/70") == .album(70))
    #expect(Route(href: "/artists/7") == .artist(7))
    #expect(Route(href: "/albums") == .albums(.artist))
    #expect(Route(href: "/albums?sort=added") == .albums(.added))
    #expect(Route(href: "/playlists/3") == .playlist(3))
    #expect(Route(href: "/mixes/genre-electronic") == .mix("genre-electronic"))
    #expect(Route(href: "/settings/listening?range=2026") == .listening)
    #expect(Route(href: "/settings/playback") == .settingsPanel(.playback))
    #expect(Route(href: "/settings/analysis") == .settingsPanel(.analysis))
    #expect(Route(href: "/nowhere") == nil)
  }

  @Test func opensPagesOnTheCurrentTab() {
    let router = AppRouter()
    router.select(.library)
    router.open(.artists)
    router.open(.artist(7))
    #expect(router.paths[.library] == [.artists, .artist(7)])
    #expect(router.paths[.home] == nil)
  }

  @Test func pickingTheTabShownGoesBackToItsFirstPage() {
    let router = AppRouter()
    router.open(.album(70))
    router.select(.home)
    #expect(router.paths[.home] == [])
  }

  @Test func nowPlayingClosesToGoSomewhere() {
    let router = AppRouter()
    router.nowPlaying = true
    router.open(href: "/albums/70")
    #expect(!router.nowPlaying)
    #expect(router.paths[.home] == [.album(70)])
    router.nowPlaying = true
    router.open(href: "/queue")
    #expect(router.tab == .queue)
    #expect(!router.nowPlaying)
  }
}
