import Foundation
import Testing
@testable import PlayarrUI

@MainActor @Suite struct RouterLayoutTests {
  @Test func opensPagesInTheDetailColumn() {
    let router = AppRouter()
    router.setLayout(.split)
    router.select(sidebar: .albums)
    router.open(.album(70))
    #expect(router.detail == [.album(70)])
    #expect(router.paths.isEmpty)
    router.select(sidebar: .albums)
    #expect(router.detail.isEmpty)
  }

  @Test func opensTheQueueBesideThePageOnAnIPad() {
    let router = AppRouter()
    router.setLayout(.split)
    router.nowPlaying = true
    router.showQueue()
    #expect(router.column == .queue)
    #expect(!router.nowPlaying)
    #expect(router.sidebar == .home)
  }

  @Test func goesToSearchFromTheKeyboard() {
    let router = AppRouter()
    router.open(.album(70))
    router.openSearch()
    #expect(router.tab == .search)
    #expect(router.focusSearch)
    router.focusSearch = false
    router.setLayout(.split)
    router.select(sidebar: .artists)
    router.openSearch()
    #expect(router.sidebar == .search)
    #expect(router.focusSearch)
  }

  @Test func backHomeLeavesAPageThatCouldntLoad() {
    let router = AppRouter()
    router.select(.library)
    router.open(.album(70))
    router.nowPlaying = true
    router.goHome()
    #expect(router.tab == .home)
    #expect(router.paths[.home] == [])
    #expect(!router.nowPlaying)
    // The page that failed stays where it was, to try again from later.
    #expect(router.paths[.library] == [.album(70)])
    router.open(.artist(7))
    router.goHome()
    #expect(router.paths[.home] == [])
    router.setLayout(.split)
    router.select(sidebar: .albums)
    router.open(.album(70))
    router.goHome()
    #expect(router.sidebar == .home)
    #expect(router.detail.isEmpty)
  }

  @Test func keepsThePageWhenTheWindowChangesWidth() {
    let router = AppRouter()
    router.select(.library)
    router.open(.artists)
    router.open(.artist(7))
    router.setLayout(.split)
    #expect(router.sidebar == .artists)
    #expect(router.detail == [.artist(7)])
    router.open(.album(70))
    router.column = .lyrics
    router.setLayout(.tabs)
    #expect(router.tab == .library)
    #expect(router.paths[.library] == [.artists, .artist(7), .album(70)])
    #expect(router.column == nil)
  }
}
