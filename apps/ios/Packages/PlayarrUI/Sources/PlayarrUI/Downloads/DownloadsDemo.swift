#if DEBUG
  import Foundation
  import PlayarrAPI
  import PlayarrPlayer
  import SwiftUI
  import Synchronization

  /// Library → Downloads with made-up downloads, for the UI tests (launch argument `-UITestsDownloads`): "Mezzanine"
  /// complete, and "Late Night" with 3 of its 10 songs here, one the server refuses and one downloading for ever. No
  /// server, no network.
  public struct DownloadsDemoView: View {
    @State private var demo = DownloadsDemo()

    public init() {}

    public var body: some View {
      NavigationStack {
        DownloadsView(store: demo.store, play: { demo.playing = $0.title }, open: { _ in }) { _ in
          Rectangle().fill(.secondary.opacity(0.3))
        }
        .safeAreaInset(edge: .bottom) {
          if let playing = demo.playing { Text("Playing \(playing)").padding() }
        }
      }
    }
  }

  @MainActor @Observable
  final class DownloadsDemo {
    static let songBytes = 44 * OfflineLimit.megabyte

    let store: DownloadStore
    var playing: String?

    init() {
      let root = FileManager.default.temporaryDirectory.appending(path: "playarr-downloads-demo/demo/1", directoryHint: .isDirectory)
      try? FileManager.default.removeItem(at: root)
      let folder = OfflineFolder(root: root)
      folder.prepare()
      let mezzanine = (1...11).map { Self.track($0, album: 1, title: "Mezzanine", artist: "Massive Attack") }
      let lateNight = (101...110).map { Self.track($0, album: 2, title: "Late Night", artist: "Various Artists") }
      for t in mezzanine + lateNight.prefix(3) { Self.sparseFile(folder.url(folder.songPath(t)), bytes: Self.songBytes) }
      var manifest = OfflineManifest()
      manifest.pins["album:1"] = PinnedDownload(
        key: "album:1", title: "Mezzanine", subtitle: "Massive Attack", href: "/albums/1", tracks: mezzanine, addedAt: Date(timeIntervalSince1970: 1))
      manifest.pins["playlist:2"] = PinnedDownload(
        key: "playlist:2", title: "Late Night", subtitle: "Playlist", href: "/playlists/2", tracks: lateNight, addedAt: Date(timeIntervalSince1970: 2))
      JSONFile<OfflineManifest>(folder.manifest).write(manifest)
      let settings = PlaybackSettings(defaults: UserDefaults(suiteName: "playarr.downloads-demo") ?? .standard)
      store = DownloadStore(
        folder: folder, settings: settings, cache: StreamCache(directory: folder.stream), transport: DemoTransport(refusing: 104),
        backend: DemoBackend(), capacity: { 64 * OfflineLimit.gigabyte })
    }

    static func track(_ id: Int, album: Int, title: String, artist: String) -> Track {
      Track(
        id: id, recordingId: "rec-\(id)", fileId: id, albumId: album, artistId: album, title: "Song \(id)", artistName: artist,
        albumTitle: title, trackNumber: id % 100, discNumber: 1, duration: 240, explicit: false,
        format: AudioFormat(codec: "FLAC", container: "flac", lossless: true), size: Int(songBytes), streamUrl: "/stream/\(id)")
    }

    /// A file that says it's `bytes` long and takes no room (APFS keeps the hole).
    static func sparseFile(_ url: URL, bytes: Int64) {
      FileManager.default.createFile(atPath: url.path(percentEncoded: false), contents: nil)
      guard let handle = try? FileHandle(forWritingTo: url) else { return }
      try? handle.truncate(atOffset: UInt64(bytes))
      try? handle.close()
    }
  }

  /// Refuses one song as the server would ("Unknown track file"); every other job runs for ever.
  final class DemoTransport: DownloadTransport {
    private let refused: Int
    private let handler = Mutex<(@Sendable (TransportEvent) -> Void)?>(nil)

    init(refusing fileId: Int) { refused = fileId }

    func setHandler(_ handler: @escaping @Sendable (TransportEvent) -> Void) { self.handler.withLock { $0 = handler } }
    func start(_ job: TransportJob) {
      guard job.id.hasSuffix("/stream/\(refused).flac") else { return }
      handler.withLock { $0 }?(.failed(id: job.id, failure: .server(status: 404, message: "Unknown track file"), resumeData: nil))
    }
    func cancel(_ id: String) {}
    func running() async -> Set<String> { [] }
  }

  /// A server that's never there: nothing in the demo asks it.
  struct DemoBackend: PlayerBackend {
    func levels(_ recordingIds: [String]) async throws -> [String: TrackLevel] { [:] }
    func reportPlays(_ plays: [PlayReport]) async throws {}
    func radio(seeds: [String], exclude: [String], count: Int) async throws -> [Track] { [] }
    func streamRequest(_ track: Track) -> URLRequest { URLRequest(url: URL(filePath: "/dev/null")) }
    func levelledRequest(_ track: Track) -> URLRequest { URLRequest(url: URL(filePath: "/dev/null")) }
    func artwork(_ track: Track, size: Int) async -> Data? { nil }
    func transition(_ request: TransitionRequest) async throws -> TransitionAnswer { .unavailable(.init(reason: "Demo")) }
    func mixMaps(_ recordingIds: [String]) async throws -> [String: MixMapEntry] { [:] }
    func transitionRequest(_ path: String) -> URLRequest { URLRequest(url: URL(filePath: "/dev/null")) }
  }
#endif
