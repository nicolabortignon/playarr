import Foundation
import Testing
@testable import PlayarrUI

/// Search's recent searches, as the web's (apps/web/src/lib/recentSearches.test.ts): each account's own on this device,
/// the last eight, newest first.
@MainActor @Suite struct RecentSearchesTests {
  private func file() -> URL {
    FileManager.default.temporaryDirectory.appending(path: "playarr-recents-\(UUID().uuidString)/recent-searches.json")
  }

  @Test func keepsTheNewestFirstOnceWhateverItsCapitalsAccentsOrSpaces() {
    let recents = RecentSearches()
    recents.record("radiohead")
    recents.record("massive attack")
    recents.record("  Radiohead ")
    #expect(recents.list == ["Radiohead", "massive attack"])
    recents.record("Björk")
    recents.record("bjork")
    #expect(recents.list == ["bjork", "Radiohead", "massive attack"])
    recents.record("massive   attack")
    #expect(recents.list == ["massive attack", "bjork", "Radiohead"])
  }

  @Test func aSearchThatOnlyCarriesOnFromTheNewestTakesItsPlace() {
    let recents = RecentSearches()
    recents.record("massive attack")
    recents.record("radio")
    recents.record("radiohead")
    // "radio" was typed on the way to "radiohead".
    #expect(recents.list == ["radiohead", "massive attack"])
    // Going back to fewer letters is a search of its own.
    recents.record("radio")
    #expect(recents.list == ["radio", "radiohead", "massive attack"])
  }

  @Test func ignoresALetterOnItsOwnAndKeepsTheLastEight() {
    let recents = RecentSearches()
    recents.record("a")
    recents.record("  ")
    #expect(recents.list.isEmpty)
    for i in 0..<(RecentSearches.limit + 3) { recents.record("artist \(i) x") }
    #expect(recents.list.count == 8)
    #expect(recents.list.first == "artist 10 x")
  }

  @Test func eachAccountKeepsItsOwnOnThisDevice() {
    let sams = file(), jos = file()
    let sam = RecentSearches(file: sams)
    let jo = RecentSearches(file: jos)
    sam.record("radiohead")
    jo.record("portishead")
    #expect(sam.list == ["radiohead"])
    #expect(jo.list == ["portishead"])
    // Kept: the next time the account signs in here, they're still there.
    #expect(RecentSearches(file: sams).list == ["radiohead"])
    #expect(RecentSearches(file: jos).list == ["portishead"])
  }

  @Test func survivesAFileItCantRead() throws {
    let unreadable = file()
    try FileManager.default.createDirectory(at: unreadable.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("not json".utf8).write(to: unreadable)
    #expect(RecentSearches(file: unreadable).list.isEmpty)
    try Data(#"["massive attack", "", "  ", "a", "b", "c", "d", "e", "f", "g", "h", "i"]"#.utf8).write(to: unreadable)
    #expect(RecentSearches(file: unreadable).list == ["massive attack", "a", "b", "c", "d", "e", "f", "g"])
  }

  @Test func removingOneOrAllHappensAtOnceWithUndo() {
    let toasts = ToastCenter(clock: TestClock())
    let recents = RecentSearches()
    recents.record("radiohead")
    recents.record("portishead")
    recents.remove("radiohead", toasts: toasts)
    #expect(recents.list == ["portishead"])
    #expect(toasts.toasts.map(\.message) == ["Removed “radiohead” from recent searches"])
    #expect(toasts.toasts.first?.action?.label == "Undo")
    toasts.perform(toasts.toasts[0])
    #expect(recents.list == ["portishead", "radiohead"])

    recents.removeAll(toasts: toasts)
    #expect(recents.list.isEmpty)
    #expect(toasts.toasts.map(\.message) == ["Cleared recent searches"])
    toasts.perform(toasts.toasts[0])
    #expect(recents.list == ["portishead", "radiohead"])
  }

  @Test func aSearchCountsOnceItsWordsSitStillForTwoAndAHalfSeconds() async {
    let clock = TestClock()
    let recents = RecentSearches()
    let typing = Task { await recents.recordWhenSettled("portis", clock: clock) }
    #expect(await clock.nextSleep() == .milliseconds(2500))
    // Another letter: the field's words changed, so the wait starts again for them.
    typing.cancel()
    await typing.value
    #expect(recents.list.isEmpty)
    let settled = Task { await recents.recordWhenSettled("portishead", clock: clock) }
    clock.advance(by: await clock.nextSleep())
    await settled.value
    #expect(recents.list == ["portishead"])
  }

  @Test func aResultOpenedFromSearchIsAPageOverIt() {
    let router = AppRouter()
    #expect(router.searchDepth == 0)
    router.tab = .search
    router.open(.artist(7))
    #expect(router.searchDepth == 1)
    // Another tab's pages aren't over Search.
    router.tab = .home
    router.open(.album(70))
    #expect(router.searchDepth == 1)
    // On an iPad: the detail column's pages, while Search is the sidebar's item.
    router.setLayout(.split)
    router.select(sidebar: .search)
    #expect(router.searchDepth == 0)
    router.open(.album(70))
    #expect(router.searchDepth == 1)
    router.select(sidebar: .albums)
    router.open(.album(70))
    #expect(router.searchDepth == 0)
  }
}
