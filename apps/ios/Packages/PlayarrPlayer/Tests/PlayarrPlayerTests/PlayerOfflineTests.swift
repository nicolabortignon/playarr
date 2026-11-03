import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

@MainActor
@Suite(.serialized)
struct PlayerOfflineTests {
  /// An account folder where these songs' whole files are already on the device.
  func folder(keeping ids: [Int]) throws -> URL {
    let directory = temporaryDirectory().appending(path: "srv-1/1")
    let stream = directory.appending(path: "stream")
    try FileManager.default.createDirectory(at: stream, withIntermediateDirectories: true)
    for id in ids { try Data(count: 100).write(to: stream.appending(path: "\(id).flac")) }
    return directory
  }

  func offline(_ player: Player) {
    player.network = { .offline }
    player.networkChanged(.offline)
  }

  @Test func offlineSkipsToTheNextSongOnThisDeviceWithTheWebsToast() throws {
    let player = try Player.testing(directory: try folder(keeping: [3, 5]))
    offline(player)
    player.play([song(1), song(2), song(3), song(4), song(5)])
    #expect(player.queue.pos == 2)
    #expect(player.queue.playing)
    #expect(player.notice?.text == "Offline: skipped songs that aren’t on this device")
    // Song 4 isn't here: nothing is joined after song 3; it'll be skipped when song 3 ends.
    #expect(player.upcoming == nil)
    player.next()
    #expect(player.queue.pos == 4)
  }

  @Test func offlineWithNothingKeptAheadTriesTheSongAndSaysWhy() throws {
    let player = try Player.testing(directory: try folder(keeping: []))
    offline(player)
    player.play([song(1), song(2)])
    #expect(player.queue.pos == 0)
    #expect(player.notice == nil)
  }

  @Test func aSongThatBreaksOffOfflineSkipsToAKeptOne() async throws {
    struct Broken: PCMSource {
      func read(maxFrames: Int) async throws -> PCMBlock? { throw PlaybackError.unreachable }
      func close() async {}
    }
    let directory = try folder(keeping: [2])
    let player = try Player(
      backend: FakeBackend(), directory: directory, settings: PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!),
      transport: FakeTransport(base: OfflineFolder(root: directory).base),
      makeEngine: { try AudioEngine(manualRendering: true, makeSource: $0) },
      makeSource: { item, frame -> any PCMSource in
        item.track.fileId == 1 ? Broken() : SignalSource(seconds: item.track.duration, from: frame, signal: Signals.sine)
      })
    player.play([song(1), song(2)])  // online when it starts
    player.network = { .offline }  // then the connection goes
    await player.engine.settle()
    await eventually { player.queue.pos == 1 }
    #expect(player.queue.pos == 1)
    #expect(player.error == nil)
    #expect(player.notice?.text == "Offline: skipped songs that aren’t on this device")
  }

  @Test func playReportsWaitOfflineAndGoWhenTheConnectionIsBack() async throws {
    let backend = FakeBackend()
    backend.reachable.value = false
    let player = try Player.testing(backend, directory: try folder(keeping: [1, 2]))
    offline(player)
    player.play([song(1, duration: 2), song(2, duration: 2)])
    try await player.play(for: 2.6)
    try await Task.sleep(for: .milliseconds(50))
    #expect(backend.plays.withLock { $0.isEmpty })
    backend.reachable.value = true
    player.network = { .wifi }
    player.networkChanged(.wifi)
    await eventually { !backend.plays.withLock { $0.isEmpty } }
    #expect(backend.plays.withLock { $0.map(\.trackId) } == [1])
  }

  @Test func keepsAheadByTheNetworkAndAlwaysWhatPlaysNowAndNext() async throws {
    let player = try Player.testing()
    player.play((401...405).map { song($0) })
    await eventually { player.downloads.protectedSongs == [401, 402, 403, 404] }
    #expect(player.downloads.protectedSongs == [401, 402, 403, 404])
    player.network = { .cellular }
    player.networkChanged(.cellular)
    await eventually { player.downloads.protectedSongs == [401, 402] }
    player.settings.offlineLimit = 0
    player.next()
    await eventually { player.downloads.protectedSongs == [402, 403] }
    #expect(player.downloads.protectedSongs == [402, 403])
  }

  @Test func downloadsLevelsPlayOfflineLevelled() throws {
    let directory = try folder(keeping: [])
    var manifest = OfflineManifest()
    manifest.pins["album:1"] = PinnedDownload(key: "album:1", title: "Dummy", href: "/albums/1", tracks: [song(1)], levels: ["rec-1": TrackLevel(track: -4)])
    JSONFile<OfflineManifest>(directory.appending(path: "offline.json")).write(manifest)
    let player = try Player.testing(directory: directory)
    #expect(player.levels.levels["rec-1"] == TrackLevel(track: -4))
  }
}
