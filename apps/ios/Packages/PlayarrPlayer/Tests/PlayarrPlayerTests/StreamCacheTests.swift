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

  /// On the phone the cache is under "Library/Application Support": a space in its path must neither stop a song's file
  /// being written (every song failed with "kept stopping loading") nor hide the file once it's here.
  @Test func keepsSongsInAFolderWithASpaceInItsName() async throws {
    StubServer.serve("/stream/211", .init(body: body))
    let cache = StreamCache(
      directory: temporaryDirectory().appending(path: "Application Support/Playarr"), retryDelay: .milliseconds(5),
      configuration: StubServer.configuration)
    let download = await cache.download(for: song(211), request: StubServer.request("/stream/211"))
    try await download.waitUntilFinished()
    let file = try #require(await cache.completedFile(for: song(211)))
    #expect(try Data(contentsOf: file) == body)
    await cache.remove([211])
    #expect(await cache.completedFile(for: song(211)) == nil)
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

@Suite(.serialized)
struct StreamCacheLedgerTests {
  let body = Data(repeating: 7, count: 100_000)

  @Test func tellsItsLedgerOfWholeFilesAndPlaysAndLeavesTheDroppingToIt() async throws {
    for id in 231...233 { StubServer.serve("/stream/\(id)", .init(body: body)) }
    let events = Recorder<StreamCache.Event>()
    let cache = StreamCache(directory: temporaryDirectory(), maxBytes: 150_000, retryDelay: .milliseconds(5), configuration: StubServer.configuration)
    await cache.keepBooks { events.append($0) }
    for id in 231...233 {
      try await cache.download(for: song(id), request: StubServer.request("/stream/\(id)")).waitUntilFinished()
    }
    await eventuallyAsync { events.all.count == 3 }
    // Past its own limit, nothing went: the ledger decides.
    #expect(await cache.completedFile(for: song(231)) != nil)
    let completed = events.all.compactMap { event -> Int? in
      if case .completed(let id, let file, let bytes) = event, bytes == 100_000, file.lastPathComponent == "\(id).flac" { return id }
      return nil
    }
    #expect(completed.sorted() == [231, 232, 233])
    #expect(events.all.last == .used(fileId: 231))
    await cache.remove([231, 232])
    #expect(await cache.completedFile(for: song(231)) == nil)
    #expect(await cache.completedFile(for: song(233)) != nil)
  }

  @Test func stillDropsThePlayersOldTransitionFilesWithALedger() async throws {
    for name in ["t1.flac", "t2.flac"] { StubServer.serve("/transitions/\(name)", .init(body: body)) }
    StubServer.serve("/stream/234", .init(body: body))
    let cache = StreamCache(directory: temporaryDirectory(), maxBytes: 150_000, retryDelay: .milliseconds(5), configuration: StubServer.configuration)
    await cache.keepBooks { _ in }
    try await cache.download(for: song(234), request: StubServer.request("/stream/234")).waitUntilFinished()
    try await cache.transition(named: "t1.flac", request: StubServer.request("/transitions/t1.flac")).waitUntilFinished()
    try await Task.sleep(for: .milliseconds(20))
    try await cache.transition(named: "t2.flac", request: StubServer.request("/transitions/t2.flac")).waitUntilFinished()
    // Looking without opening (opening marks a file as just played).
    @Sendable func here(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path()) }
    let t1 = await cache.transitionFile(named: "t1.flac")
    await eventuallyAsync { !here(t1) }
    // Transitions the player fetched stay within the cache's own limit; songs are the ledger's.
    #expect(!here(t1))
    #expect(here(await cache.transitionFile(named: "t2.flac")))
    #expect(here(await cache.file(for: song(234))))
  }
}

/// Waits (up to a second) for something another task does.
func eventuallyAsync(_ condition: @Sendable () async -> Bool) async {
  for _ in 0..<1000 where !(await condition()) { try? await Task.sleep(for: .milliseconds(1)) }
}
