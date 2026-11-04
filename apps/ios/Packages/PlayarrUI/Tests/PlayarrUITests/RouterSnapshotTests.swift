import Foundation
import Testing
@testable import PlayarrUI

@MainActor @Suite struct RouterSnapshotTests {
  @Test func bringsTheAppBackWhereItWas() throws {
    let router = AppRouter()
    router.setLayout(.split)
    router.select(sidebar: .playlist(3))
    router.open(.album(70))
    router.column = .lyrics
    router.nowPlaying = true
    let data = try #require(router.snapshot(account: "demo-server/1").data)

    let again = AppRouter()
    again.restore(try #require(RouterSnapshot(data: data)), account: "demo-server/1", hasSong: true)
    #expect(again.layout == .split)
    #expect(again.sidebar == .playlist(3))
    #expect(again.detail == [.album(70)])
    #expect(again.column == .lyrics)
    #expect(again.nowPlaying)
  }

  @Test func keepsPhoneStacksAndSettingsPanels() throws {
    let router = AppRouter()
    router.select(.library)
    router.open(.settings)
    router.open(.settingsPanel(.appearance))
    let snapshot = try #require(RouterSnapshot(data: router.snapshot(account: "a").data))
    #expect(snapshot.paths[.library] == [.settings, .settingsPanel(.appearance)])
  }

  @Test func leavesAnotherAccountsPlaceAlone() throws {
    let router = AppRouter()
    router.open(.album(70))
    let snapshot = router.snapshot(account: "demo-server/1")
    let other = AppRouter()
    other.restore(snapshot, account: "demo-server/2", hasSong: true)
    #expect(other.paths.isEmpty)
  }

  @Test func opensNowPlayingOnlyWithASong() {
    let router = AppRouter()
    router.nowPlaying = true
    let other = AppRouter()
    other.restore(router.snapshot(account: "a"), account: "a", hasSong: false)
    #expect(!other.nowPlaying)
  }

  @Test func ignoresWhatItCantRead() {
    #expect(RouterSnapshot(data: Data("{}".utf8)) == nil)
    #expect(RouterSnapshot(data: nil) == nil)
  }
}
