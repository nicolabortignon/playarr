import Foundation
import Testing
@testable import PlayarrPlayer

@Suite(.serialized)
struct StreamCacheTests {
  let body = Data(repeating: 7, count: 100_000)

  func cache(maxBytes: Int64 = 1 << 30) -> StreamCache {
    StreamCache(directory: temporaryDirectory(), maxBytes: maxBytes, retryDelay: .milliseconds(5), configuration: StubServer.configuration)
  }

  @Test func prefetchesOneSongAtATimeInOrder() async throws {
    for id in 201...203 { StubServer.serve("/stream/\(id)", .init(body: body)) }
    let cache = cache()
    await cache.prefetch((201...203).map { (song($0), StubServer.request("/stream/\($0)")) })
    for _ in 0..<500 where await cache.completedFile(for: song(203)) == nil { try await Task.sleep(for: .milliseconds(2)) }
    #expect(await cache.completedFile(for: song(203)) != nil)
    #expect(StubServer.requests("/stream/201").count == 1)
    #expect(StubServer.requests("/stream/203").count == 1)
  }

  @Test func theNetworkPolicyIsThreeOnWiFiOneOnMobileDataNoneOtherwise() {
    #expect(PrefetchPolicy.songsAhead(on: .wifi) == 3)
    #expect(PrefetchPolicy.songsAhead(on: .cellular) == 1)
    #expect(PrefetchPolicy.songsAhead(on: .constrained) == 0)
    #expect(PrefetchPolicy.songsAhead(on: .offline) == 0)
  }

  @Test func dropsTheLeastRecentlyPlayedPastItsLimit() async throws {
    for id in 211...213 { StubServer.serve("/stream/\(id)", .init(body: body)) }
    let cache = cache(maxBytes: 250_000)
    for id in 211...213 {
      try await cache.download(for: song(id), request: StubServer.request("/stream/\(id)")).waitUntilFinished()
      try await Task.sleep(for: .milliseconds(20))
    }
    try await Task.sleep(for: .milliseconds(50))
    #expect(await cache.completedFile(for: song(211)) == nil)
    #expect(await cache.completedFile(for: song(213)) != nil)
  }

  @Test func keepOnlyStopsTheOthers() async throws {
    StubServer.serve("/stream/221", .init(body: body, pause: .seconds(5)))
    let cache = cache()
    let d = await cache.download(for: song(221), request: StubServer.request("/stream/221"))
    await cache.keepOnly([])
    await #expect(throws: CancellationError.self) { try await d.waitUntilFinished() }
  }

  @Test func keepsTransitionFilesBesideTheSongsAndDownloadsEachOnce() async throws {
    StubServer.serve("/transitions/abc.flac", .init(body: body))
    let cache = cache()
    #expect(await cache.completedTransition(named: "abc.flac") == nil)
    let first = await cache.transition(named: "abc.flac", request: StubServer.request("/transitions/abc.flac"))
    let again = await cache.transition(named: "abc.flac", request: StubServer.request("/transitions/abc.flac"))
    #expect(first === again)
    try await first.waitUntilFinished()
    let file = try #require(await cache.completedTransition(named: "abc.flac"))
    #expect(file.lastPathComponent == "transition-abc.flac")
    #expect(try Data(contentsOf: file) == body)
    #expect(StubServer.requests("/transitions/abc.flac").count == 1)
  }
}
