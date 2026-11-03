import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrUI

@MainActor @Suite struct QueryCacheTests {
  let directory = FileManager.default.temporaryDirectory.appending(path: "queries-\(UUID().uuidString)", directoryHint: .isDirectory)

  @Test func keepsTheLibraryOnDiskForTheNextLaunch() async throws {
    let first = QueryCache(directory: directory)
    _ = try await first.fetch(.albums(.artist)) { ["Mezzanine"] }
    _ = try await first.fetch(.search("mezz")) { ["Mezzanine"] }
    await first.flush()

    let next = QueryCache(directory: directory)
    #expect(next.cached(.albums(.artist), as: [String].self)?.value == ["Mezzanine"])
    // Search answers, like the web's, aren't kept between launches.
    #expect(next.cached(.search("mezz"), as: [String].self) == nil)
  }

  @Test func neverKeepsAShuffle() {
    #expect(QueryKey.albums(.added, limit: 14).isKept)
    #expect(!QueryKey.randomAlbums(seed: 0).isKept)
    #expect(!QueryKey.health.isKept)
    #expect(QueryKey.playlist(3).isKept)
  }

  @Test func forgetsWhatIsOlderThanSevenDays() async throws {
    var clock = Date(timeIntervalSince1970: 1_800_000_000)
    let first = QueryCache(directory: directory) { clock }
    _ = try await first.fetch(.artists) { ["Massive Attack"] }
    await first.flush()
    clock += QueryCache.keepFor + 1
    let later = QueryCache(directory: directory) { clock }
    #expect(later.cached(.artists, as: [String].self) == nil)
  }

  @Test func keepsADownloadsPageHoweverOld() async throws {
    var clock = Date(timeIntervalSince1970: 1_800_000_000)
    let first = QueryCache(directory: directory) { clock }
    _ = try await first.fetch(.album(70)) { ["Mezzanine"] }
    await first.flush()
    clock += 8 * 24 * 60 * 60
    let pinned = QueryCache(directory: directory) { clock }
    pinned.setPinned([["album", "70"]])
    await pinned.removeExpired()
    #expect(pinned.cached(.album(70), as: [String].self)?.value == ["Mezzanine"])
    let unpinned = QueryCache(directory: directory) { clock }
    #expect(unpinned.cached(.album(70), as: [String].self) == nil)
  }

  @Test func keepsADownloadedMixsPageOnDisk() async throws {
    let first = QueryCache(directory: directory)
    first.setPinned([["mix", "x"]])
    _ = try await first.fetch(.mix("x")) { ["Late Night"] }
    await first.flush()
    let next = QueryCache(directory: directory)
    next.setPinned([["mix", "x"]])
    #expect(next.cached(.mix("x"), as: [String].self)?.value == ["Late Night"])
    // Not downloaded: a mix's page isn't kept between launches.
    #expect(QueryCache(directory: directory).cached(.mix("x"), as: [String].self) == nil)
  }

  @Test func isStaleAfterItsTime() async throws {
    var clock = Date(timeIntervalSince1970: 1_800_000_000)
    let cache = QueryCache(directory: nil) { clock }
    #expect(cache.isStale(.health, after: 30))
    _ = try await cache.fetch(.health) { 1 }
    #expect(!cache.isStale(.health, after: 30))
    clock += 30
    #expect(cache.isStale(.health, after: 30))
  }

  @Test func asksOnceForTwoAsksAtTheSameTime() async throws {
    let clock = TestClock()
    let asked = Mutex(0)
    let load: @Sendable () async throws -> [String] = {
      asked.withLock { $0 += 1 }
      // The server takes a second: the second ask comes while the first waits.
      try await clock.sleep(for: .seconds(1))
      return ["Massive Attack"]
    }
    let cache = QueryCache(directory: nil)
    async let first = cache.fetch(.artists, load)
    async let second = cache.fetch(.artists, load)
    _ = await clock.nextSleep()
    clock.advance(by: .seconds(1))
    #expect(try await first == second)
    #expect(asked.withLock { $0 } == 1)
  }

  @Test func invalidatingMakesAnAnswerStale() async throws {
    let cache = QueryCache(directory: nil)
    _ = try await cache.fetch(.playlists) { [1] }
    cache.invalidate("playlists")
    #expect(cache.isStale(.playlists, after: 60))
  }

  @Test func namesFilesSafely() {
    #expect(QueryKey.album(70).fileName == "album--70.json")
    #expect(!QueryKey.search("a/b").fileName.contains("/"))
  }
}
