import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// A store over a fresh account folder, a fake background session and the stub server.
@MainActor
final class StoreRig {
  let folder: OfflineFolder
  let transport: FakeTransport
  let backend = FakeBackend()
  let settings = PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!)
  let cache: StreamCache
  let room = Shared<Int64>(100 * OfflineLimit.gigabyte)
  let announced = Recorder<String>()
  private(set) var store: DownloadStore!

  init(folder: OfflineFolder? = nil, open: Bool = true) {
    let folder = folder ?? OfflineFolder(root: temporaryDirectory().appending(path: "srv-1/1"))
    self.folder = folder
    transport = FakeTransport(base: folder.base)
    cache = StreamCache(directory: folder.stream, retryDelay: .milliseconds(5), configuration: StubServer.configuration)
    if open { self.open() }
  }

  func open() {
    let room = self.room
    store = DownloadStore(
      folder: folder, settings: settings, cache: cache, transport: transport, backend: backend,
      capacity: { room.value }, poll: TransitionPoller.Timing(poll: .milliseconds(1), slowPoll: .milliseconds(2), fastPolls: 5, giveUp: .milliseconds(100)))
    store.announce = { [announced] text, _ in announced.append(text) }
  }

  func job(_ fileId: Int, _ ext: String = "flac") -> String { folder.jobID("stream/\(fileId).\(ext)") }

  /// Waits for the store to start the job of this song, then finishes it.
  func finish(_ fileId: Int, bytes: Int = 1000) async {
    await eventually { self.transport.runningIDs.contains(self.job(fileId)) }
    transport.finish(job(fileId), bytes: bytes)
    await eventually { self.store.isKept(fileId) }
  }

  /// A song the player streamed: the real stream cache fetches it from the stub server and tells the store, which
  /// keeps it or (`kept: false`) drops it at once to stay within the limit.
  func play(_ fileId: Int, bytes: Int = 700, kept: Bool = true) async throws {
    StubServer.serve("/stream/\(fileId)", .init(body: Data(count: bytes)))
    try await cache.download(for: song(fileId), request: StubServer.request("/stream/\(fileId)")).waitUntilFinished()
    if kept {
      await eventually { self.store.isKept(fileId) }
    } else {
      await eventuallyAsync { await self.cache.completedFile(for: song(fileId)) == nil }
    }
  }
}

func album(_ ids: [Int], key: String = "album:1") -> (key: String, title: String, href: String, tracks: [Track]) {
  (key, "Dummy", "/albums/1", ids.map { song($0) })
}

extension DownloadStore {
  func add(_ d: (key: String, title: String, href: String, tracks: [Track])) {
    add(key: d.key, title: d.title, href: d.href, tracks: d.tracks)
  }
}

@MainActor
@Suite(.serialized)
struct DownloadStoreTests {
  @Test func keepsADownloadsSongsBeyondTheLimitAndTheyNeverMakeRoom() async throws {
    let rig = StoreRig()
    rig.settings.offlineLimit = 1000
    rig.store.add(album([4, 5, 6]))
    for id in [4, 5, 6] { await rig.finish(id, bytes: 500) }
    #expect(rig.store.progress(of: "album:1") == DownloadProgress(done: 3, total: 3, bytes: 1500))
    // A song kept as you listen fits within the limit on its own.
    try await rig.play(7)
    #expect(rig.store.keptAsYouListen.count == 1)
    #expect(rig.store.downloadsBytes == 1500)
    // Turning keeping-as-you-listen off leaves downloads alone.
    rig.store.limit = 0
    #expect(rig.store.manifest.songs.keys.sorted() == [4, 5, 6])
    await eventuallyAsync { await rig.cache.completedFile(for: song(7)) == nil }
    #expect(await rig.cache.completedFile(for: song(7)) == nil)
  }

  @Test func removingADownloadLetsItsSongsGoWithinTheLimit() async throws {
    let rig = StoreRig()
    rig.settings.offlineLimit = 1200
    rig.store.add(album([4, 5, 6]))
    for id in [4, 5, 6] { await rig.finish(id, bytes: 500) }
    rig.store.remove("album:1")
    #expect(rig.store.manifest.pins.isEmpty)
    #expect(rig.store.keptAsYouListen.bytes <= 1200)
    #expect(rig.store.manifest.songs.count == 2)
    await eventually { rig.folder.songFiles().count == 2 }
    #expect(rig.folder.songFiles().keys.sorted() == rig.store.manifest.songs.keys.sorted())
  }

  @Test func onlyDownloadedSongsCountAsDownloadedNotThoseKeptAsYouListen() async throws {
    // The "on this device" mark: a download's songs once here, never a song only kept ahead as it played.
    let rig = StoreRig()
    try await rig.play(7)
    #expect(rig.store.isKept(7))
    #expect(!rig.store.isDownloaded(7))
    rig.store.add(album([4, 5]))
    #expect(!rig.store.isDownloaded(4))  // asked for, not here yet
    await rig.finish(4)
    #expect(rig.store.isDownloaded(4))
    // Played, then downloaded: marked once a download has it.
    rig.store.add(album([7], key: "playlist:2"))
    #expect(rig.store.isDownloaded(7))
    // Taken off the device, its songs are only kept as you listen.
    rig.store.remove("album:1")
    #expect(rig.store.isKept(4))
    #expect(!rig.store.isDownloaded(4))
    // And after a relaunch the same.
    rig.open()
    #expect(rig.store.isDownloaded(7))
    #expect(!rig.store.isDownloaded(4))
  }

  @Test func undoPutsBackADownloadJustRemovedAsItWas() async throws {
    let rig = StoreRig()
    rig.store.add(album([4, 5]))
    for id in [4, 5] { await rig.finish(id) }
    let removed = try #require(rig.store.download("album:1"))
    rig.store.remove("album:1")
    #expect(rig.store.downloads.isEmpty)
    rig.store.restore(removed)
    #expect(rig.store.download("album:1") == removed)
    #expect(rig.store.isDownloaded(4) && rig.store.isDownloaded(5))
    #expect(rig.store.progress(of: "album:1") == DownloadProgress(done: 2, total: 2, bytes: 2000))
    #expect(JSONFile<OfflineManifest>(rig.folder.manifest).read()?.pins["album:1"] == removed)
  }

  @Test func undoDownloadsAgainWhatMadeRoomMeanwhile() async throws {
    let rig = StoreRig()
    rig.settings.offlineLimit = 600
    rig.store.add(album([4, 5]))
    for id in [4, 5] { await rig.finish(id, bytes: 500) }
    let removed = try #require(rig.store.download("album:1"))
    // Removed, its songs make room within the limit: one of them goes.
    rig.store.remove("album:1")
    #expect(rig.store.manifest.songs.count == 1)
    rig.store.restore(removed)
    let gone = try #require([4, 5].first { !rig.store.isKept($0) })
    await rig.finish(gone, bytes: 500)
    #expect(rig.store.progress(of: "album:1") == DownloadProgress(done: 2, total: 2, bytes: 1000))
  }

  @Test func theSongsPlayingAndFetchedAheadNeverMakeRoom() async throws {
    let rig = StoreRig()
    rig.settings.offlineLimit = 1000
    try await rig.play(7, bytes: 600)
    rig.store.protect([7])
    try await rig.play(8, bytes: 600, kept: false)
    #expect(rig.store.isKept(7))
    #expect(!rig.store.isKept(8))  // over the limit, and not protected
  }

  @Test func downloadsOneSongAtATimeAndHandsTheSystemMoreInTheBackground() async {
    let rig = StoreRig()
    rig.store.add(album(Array(1...30)))
    await eventually { rig.transport.runningIDs.count == 1 }
    try? await Task.sleep(for: .milliseconds(20))
    #expect(rig.transport.runningIDs == [rig.job(1)])
    rig.store.appMovedToBackground()
    await eventually { rig.transport.runningIDs.count == 25 }
    #expect(rig.transport.runningIDs.first == rig.job(1))
  }

  @Test func showsTheSongDownloadingForTheProgressRings() async {
    let rig = StoreRig()
    rig.store.add(album([4]))
    await eventually { !rig.transport.runningIDs.isEmpty }
    rig.transport.progress(rig.job(4), written: 250, expected: 1000)
    await eventually { rig.store.active != nil }
    #expect(rig.store.active?.fileId == 4)
    #expect(rig.store.active?.fraction == 0.25)
    rig.transport.finish(rig.job(4))
    await eventually { rig.store.active == nil }
  }

  @Test func removingADownloadStopsItsSongAndALateFileIsDropped() async {
    let rig = StoreRig()
    rig.store.add(album([4, 5]))
    await eventually { rig.transport.runningIDs == [rig.job(4)] }
    rig.transport.holdCancels.value = true
    rig.store.remove("album:1")
    #expect(rig.transport.cancelled == [rig.job(4)])
    rig.transport.finish(rig.job(4))  // it had finished as it was stopped
    try? await Task.sleep(for: .milliseconds(30))
    #expect(!rig.store.isKept(4))
    #expect(rig.folder.songFiles().isEmpty)
  }

  @Test func failedSongsSayWhyAndAreTriedAgainWhenTheNetworkComesBack() async {
    let rig = StoreRig()
    rig.store.add(album([4, 5]))
    await eventually { rig.transport.runningIDs == [rig.job(4)] }
    rig.transport.fail(rig.job(4), .server(status: 404, message: "Unknown track file"))
    await eventually { rig.transport.runningIDs == [rig.job(5)] }
    #expect(rig.store.failed == [4: "Unknown track file"])
    #expect(rig.store.failedCount(of: "album:1") == 1)
    await rig.finish(5)
    rig.store.networkChanged(.offline)
    rig.store.networkChanged(.wifi)
    await eventually { rig.transport.runningIDs == [rig.job(4)] }
    #expect(rig.store.failed.isEmpty)
  }

  @Test func aJobTheSystemStoppedGoesOnFromItsResumeData() async {
    let rig = StoreRig()
    rig.store.add(album([4, 5]))
    await eventually { rig.transport.runningIDs == [rig.job(4)] }
    rig.transport.fail(rig.job(4), .cancelled, resumeData: Data([9, 9]))  // the app closed from the switcher
    await eventually { rig.transport.started.count == 2 }
    #expect(rig.transport.started.last?.id == rig.job(4))
    #expect(rig.transport.started.last?.resumeData == Data([9, 9]))
    #expect(rig.store.failed.isEmpty)
  }

  @Test func usesMobileDataOnlyWhenAllowed() async {
    let rig = StoreRig()
    rig.store.add(album([4]))
    await eventually { rig.transport.runningIDs.count == 1 }
    #expect(rig.transport.started[0].request.allowsCellularAccess == false)
    #expect(rig.transport.started[0].request.allowsExpensiveNetworkAccess == false)
    rig.store.cellularDownloads = true
    await eventually { rig.transport.started.count == 2 }
    #expect(rig.transport.cancelled == [rig.job(4)])
    #expect(rig.transport.started[1].request.allowsCellularAccess)
    #expect(rig.transport.started[1].request.value(forHTTPHeaderField: "Range") == nil)
  }

  @Test func outOfRoomSaysSoOnceAndChecksBeforeStarting() async {
    let rig = StoreRig()
    rig.room.value = 100 * OfflineLimit.megabyte  // under what's kept free
    #expect(rig.store.room(for: [song(1), song(2)]) == .short(needed: 2_000_000, free: 0))
    rig.store.add(album([4, 5]))
    await eventually { rig.store.failed.count == 2 }
    #expect(rig.store.failed[4] == "Not enough space on this device")
    #expect(rig.announced.all == ["This device is out of space for downloads: remove some in Library → Downloads"])
    #expect(rig.transport.started.isEmpty)
    rig.room.value = 10 * OfflineLimit.gigabyte
    #expect(rig.store.room(for: [song(1), song(2)]) == .enough)
  }

  @Test func takesOnAWholeFileTheStreamCacheHasInsteadOfDownloadingItAgain() async throws {
    let rig = StoreRig()
    try await rig.play(4)
    rig.store.add(album([4, 5]))
    await eventually { !rig.transport.runningIDs.isEmpty }
    #expect(rig.transport.started.map(\.id) == [rig.job(5)])
    #expect(rig.store.progress(of: "album:1")?.done == 1)
  }

  @Test func reconcilesWithTheDiskWhenItOpens() throws {
    let rig = StoreRig(open: false)
    rig.folder.prepare()
    var manifest = OfflineManifest(songs: [1: kept(10, file: "stream/1.flac")])
    var d = PinnedDownload(key: "album:1", title: "Dummy", href: "/albums/1", tracks: [song(1), song(2)])
    d.transitions["1-2-auto"] = KeptTransition(answer: ready(1, 2), levelled: false)
    manifest.pins["album:1"] = d
    JSONFile<OfflineManifest>(rig.folder.manifest).write(manifest)
    try Data(count: 20).write(to: rig.folder.stream.appending(path: "2.flac"))  // the stream cache's, unknown to the manifest
    try Data(count: 5).write(to: rig.folder.transitions.appending(path: "1-2.flac"))
    try Data(count: 5).write(to: rig.folder.transitions.appending(path: "old.flac"))  // no download has it
    rig.open()
    #expect(rig.store.manifest.songs.mapValues(\.bytes) == [2: 20])  // song 1's file is gone
    #expect(Array(rig.store.manifest.transitionFiles.keys) == ["1-2.flac"])
    #expect(rig.folder.transitionFiles().keys.sorted() == ["1-2.flac"])
    #expect(rig.store.manifest.pins["album:1"] != nil)
  }

  @Test func afterARelaunchSongsTheSystemIsFetchingArentAskedForAgain() async {
    let rig = StoreRig(open: false)
    var manifest = OfflineManifest()
    manifest.pins["album:1"] = PinnedDownload(key: "album:1", title: "Dummy", href: "/albums/1", tracks: [song(4), song(5)])
    rig.folder.prepare()
    JSONFile<OfflineManifest>(rig.folder.manifest).write(manifest)
    rig.transport.pretendRunning(rig.job(4))
    rig.open()
    try? await Task.sleep(for: .milliseconds(50))
    #expect(rig.transport.started.isEmpty)
    rig.transport.finish(rig.job(4))
    await eventually { rig.transport.started.map(\.id) == [rig.job(5)] }
    #expect(rig.store.isKept(4))
  }

  @Test func leavesOtherAccountsJobsAlone() async {
    let rig = StoreRig()
    rig.transport.finish("srv-1/2/stream/9.flac")
    try? await Task.sleep(for: .milliseconds(20))
    #expect(!rig.store.isKept(9))
    #expect(FileManager.default.fileExists(atPath: rig.folder.base.appending(path: "srv-1/2/stream/9.flac").path()))
  }

  @Test func keepsEvenVolumeWithADownloadForPlayingOffline() async {
    let rig = StoreRig()
    rig.backend.levelTable.withLock { $0 = ["rec-4": TrackLevel(track: -5, album: -3)] }
    rig.store.add(album([4, 5]))
    await eventually { !rig.store.keptLevels.isEmpty }
    #expect(rig.store.keptLevels == ["rec-4": TrackLevel(track: -5, album: -3)])
    #expect(JSONFile<OfflineManifest>(rig.folder.manifest).read()?.pins["album:1"]?.levels.count == 1)
  }

  @Test func removeAllLeavesNothing() async throws {
    let rig = StoreRig()
    rig.store.add(album([4, 5]))
    await rig.finish(4)
    try await rig.play(7)
    rig.store.removeAll()
    #expect(rig.store.manifest == OfflineManifest())
    await eventually { rig.folder.songFiles().isEmpty }
    #expect(rig.folder.songFiles().isEmpty)
    #expect(JSONFile<OfflineManifest>(rig.folder.manifest).read() == OfflineManifest())
  }

  @Test func anotherAccountsDownloadsAreCountedAndRemovedWithoutOpeningIt() async {
    let rig = StoreRig()
    rig.store.add(album([4]))
    await rig.finish(4, bytes: 300)
    #expect(DownloadStore.summary(of: rig.folder) == (downloads: 1, bytes: 300) )
    await DownloadStore.removeEverything(in: rig.folder, transport: rig.transport)
    #expect(DownloadStore.summary(of: rig.folder) == (downloads: 0, bytes: 0))
  }
}
