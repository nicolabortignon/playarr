import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct ShellLayoutTests {
  @Test func takesTheSidebarFromTheWebsDesktopWidth() {
    #expect(ShellLayout.choose(regularWidth: true, width: 1376) == .split)  // iPad Pro 13", landscape
    #expect(ShellLayout.choose(regularWidth: true, width: 1032) == .split)  // upright
    #expect(ShellLayout.choose(regularWidth: true, width: 768) == .split)
    #expect(ShellLayout.choose(regularWidth: true, width: 744) == .tabs)  // iPad mini upright
    #expect(ShellLayout.choose(regularWidth: true, width: 678) == .tabs)  // half the screen in Split View
    #expect(ShellLayout.choose(regularWidth: false, width: 1000) == .tabs)  // compact: Slide Over, a third
    #expect(ShellLayout.choose(regularWidth: false, width: 402) == .tabs)  // iPhone
  }

  @Test func stepsThePlayerBarAsideOnlyForTheScreensKeyboard() {
    #expect(!ShellLayout.barStepsAside(bottomInset: 0))  // a home button
    #expect(!ShellLayout.barStepsAside(bottomInset: 20))  // the home indicator
    #expect(!ShellLayout.barStepsAside(bottomInset: 70))  // a hardware keyboard's shortcuts bar
    #expect(ShellLayout.barStepsAside(bottomInset: 300))  // the keyboard on the screen
  }

  @Test func listsTheDesktopLinksInTheWebsOrder() {
    #expect(SidebarItem.links.map(\.title) == ["Home", "Search", "Made for you", "Artists", "Albums", "Favorites", "Downloads", "Queue"])
    #expect(SidebarItem.playlist(3).identifier == "sidebar.playlist.3")
    #expect(SidebarItem.mixes.identifier == "sidebar.mixes")
  }

  @Test func knowsEachItemsPage() {
    #expect(SidebarItem.home.route == nil)
    #expect(SidebarItem.albums.route == .albums(.artist))
    #expect(SidebarItem.requests.route == .requests)
    #expect(SidebarItem(route: .playlist(3)) == .playlist(3))
    #expect(SidebarItem(route: .artists) == .artists)
    #expect(SidebarItem(route: .albums(.added)) == nil)
    #expect(SidebarItem(route: .album(70)) == nil)
  }

  @Test func readsTheRequestsPath() {
    #expect(Route(href: "/requests") == .requests)
  }

  @Test func carriesAPhonesPlaceToTheSidebar() {
    #expect(SidebarItem.place(tab: .home, path: [.album(70)]) == (.home, [.album(70)]))
    #expect(SidebarItem.place(tab: .library, path: [.artists, .artist(7)]) == (.artists, [.artist(7)]))
    #expect(SidebarItem.place(tab: .library, path: [.playlist(3)]) == (.playlist(3), []))
    #expect(SidebarItem.place(tab: .library, path: []) == (.home, []))
    #expect(SidebarItem.place(tab: .library, path: [.listening]) == (.home, [.listening]))
  }

  @Test func carriesTheSidebarsPlaceToAPhone() {
    #expect(SidebarItem.queue.place(detail: []) == (.queue, []))
    #expect(SidebarItem.artists.place(detail: [.artist(7)]) == (.library, [.artists, .artist(7)]))
    #expect(SidebarItem.requests.place(detail: []) == (.library, [.requests]))
  }
}
