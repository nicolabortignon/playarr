import Foundation
import PlayarrAPI

/// Songs' files on disk, fetched ahead of playback: one `Download` per file at a time, shared by whoever reads it.
/// Files are named by file id: the song's own file `<fileId>.<ext>`, its encoded stream `<fileId>.<quality>.m4a`
/// (plan 2 §1), `.part` while incomplete; one folder per server and account (the caller's `directory`). The least recently played go first past `maxBytes`, until a ledger keeps the books
/// (`keepBooks(with:)`): then `DownloadStore` decides which songs go, with the user's limit and downloads' songs kept,
/// and the cache's own limit only applies to the transition files the player fetched.
public actor StreamCache {
  public let directory: URL
  private let maxBytes: Int64
  private let configuration: @Sendable () -> URLSessionConfiguration
  private let retryDelay: Duration
  /// By file name (`file(for:quality:)`'s).
  private var downloads: [String: Download] = [:]
  private var transitions: [String: Download] = [:]
  private var waiting: [(Track, StreamQuality, URLRequest)] = []
  private var ledger: (@Sendable (Event) -> Void)?

  /// What the cache tells whoever keeps its books (phase 7's `DownloadStore`).
  public enum Event: Sendable, Equatable {
    /// A song's whole file arrived.
    case completed(fileId: Int, file: URL, bytes: Int64)
    /// A song's whole file was opened to play.
    case used(fileId: Int)
  }

  public init(
    directory: URL, maxBytes: Int64 = 1 << 30, retryDelay: Duration = .seconds(1),
    configuration: @escaping @Sendable () -> URLSessionConfiguration = { .default }
  ) {
    self.directory = directory
    self.maxBytes = maxBytes
    self.retryDelay = retryDelay
    self.configuration = configuration
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  /// The song's file at a quality: its own file, or its encoded stream.
  public func file(for track: Track, quality: StreamQuality = .original) -> URL {
    directory.appending(path: OfflineFolder.songFileName(track, quality: quality))
  }

  /// The song's whole file at `quality` or better, if it's here: its own file first, then the encoded streams, the
  /// better first. Marks it as just played.
  public func completedFile(for track: Track, atLeast quality: StreamQuality = .original) -> URL? {
    for kind in [StreamQuality.original, .high, .normal] where kind.atLeast(quality) {
      let url = file(for: track, quality: kind)
      guard FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) else { continue }
      try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path(percentEncoded: false))
      ledger?(.used(fileId: track.fileId))
      return url
    }
    return nil
  }

  /// The download of this song's file at `quality`, started (or continued from what's here) if it isn't running. An
  /// encoded stream's ends where its padding starts.
  public func download(for track: Track, quality: StreamQuality = .original, request: URLRequest) -> Download {
    let final = file(for: track, quality: quality)
    let name = final.lastPathComponent
    if let running = downloads[name], running.isActive || running.isFinished { return running }
    let d = Download(
      request: request, file: final.appendingPathExtension("part"), finalFile: final, retryDelay: retryDelay,
      endsAtPadding: quality != .original, configuration: configuration)
    d.onFinish { [weak self] in Task { await self?.finished(name) } }
    downloads[name] = d
    d.start()
    return d
  }

  /// A DJ transition's file on disk, beside the songs (and dropped with them, least recently played first). `name` is
  /// the last part of its URL: the server names transitions by a hash of what they're made from.
  public func transitionFile(named name: String) -> URL { directory.appending(path: "transition-\(name)") }

  /// The whole transition file, if it's here. Marks it as just played.
  public func completedTransition(named name: String) -> URL? {
    let url = transitionFile(named: name)
    guard FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) else { return nil }
    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path(percentEncoded: false))
    return url
  }

  /// The download of a transition file, started (or continued) if it isn't running. It isn't queued behind the songs
  /// fetched ahead: it's needed by the mix point.
  public func transition(named name: String, request: URLRequest) -> Download {
    if let running = transitions[name], running.isActive || running.isFinished { return running }
    let final = transitionFile(named: name)
    let d = Download(
      request: request, file: final.appendingPathExtension("part"), finalFile: final, retryDelay: retryDelay, configuration: configuration)
    d.onFinish { [weak self] in Task { await self?.finishedTransition() } }
    transitions[name] = d
    d.start()
    return d
  }

  /// A download outside the cache (a levelled stream from a seek), into a file of its own removed on `discard`.
  public func temporary(request: URLRequest, firstByte: Int64) -> Download {
    let d = Download(
      request: request, firstByte: firstByte, file: directory.appending(path: "levelled-\(UUID().uuidString).wav"),
      retryDelay: retryDelay, configuration: configuration)
    d.start()
    return d
  }

  /// An encoded stream from a later sample (a seek past what's here), into a file of its own removed on `discard`:
  /// it ends at its padding.
  public func temporaryEncoded(request: URLRequest) -> Download {
    let d = Download(
      request: request, file: directory.appending(path: "encoded-\(UUID().uuidString).m4a"), retryDelay: retryDelay,
      endsAtPadding: true, configuration: configuration)
    d.start()
    return d
  }

  public func discard(_ download: Download) {
    download.cancel()
    try? FileManager.default.removeItem(at: download.file)
  }

  /// The songs to fetch ahead, each at the quality it plays at, in order (the next 3 on Wi-Fi, 1 on mobile data: see
  /// `PrefetchPolicy`): one at a time, once nothing else is downloading. Replaces the earlier list.
  public func prefetch(_ songs: [(Track, StreamQuality, URLRequest)]) {
    waiting = songs.filter { completedFile(for: $0.0, atLeast: $0.1) == nil }
    pump()
  }

  /// Stops the downloads of other songs (what's here stays, and continues later).
  public func keepOnly(_ fileIds: Set<Int>) {
    for (name, d) in downloads where !d.isFinished {
      guard let id = OfflineFolder.fileId(ofName: name), !fileIds.contains(id) else { continue }
      d.cancel()
      downloads[name] = nil
    }
    waiting.removeAll { !fileIds.contains($0.0.fileId) }
  }

  /// Hands the books to `ledger`: it hears of every whole file and every play, and decides which songs go
  /// (`remove(_:)`). The cache's own limit applies only to transition files from then on.
  public func keepBooks(with ledger: @escaping @Sendable (Event) -> Void) {
    self.ledger = ledger
    // Files that came in before there was a ledger.
    for (name, d) in downloads where d.isFinished {
      if let id = OfflineFolder.fileId(ofName: name) { report(id, d) }
    }
  }

  /// Drops these songs' files, whole or partial; not one being downloaded right now (it's being played).
  public func remove(_ fileIds: Set<Int>) {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path(percentEncoded: false))) ?? []
    for id in fileIds where !isDownloading(id) {
      for (name, _) in downloads where OfflineFolder.fileId(ofName: name) == id { downloads[name] = nil }
      for name in names where name.hasPrefix("\(id).") {
        try? FileManager.default.removeItem(at: directory.appending(path: name))
      }
    }
  }

  /// Drops a song's other whole files than `name` (one at a quality it no longer plays at), not one being downloaded.
  public func removeOthers(of fileId: Int, keeping name: String) {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path(percentEncoded: false))) ?? []
    for other in names where other != name && !other.hasSuffix(".part") && OfflineFolder.fileId(ofName: other) == fileId {
      guard downloads[other]?.isActive != true else { continue }
      downloads[other] = nil
      try? FileManager.default.removeItem(at: directory.appending(path: other))
    }
  }

  /// Whether this song's file is being fetched now (for playback or ahead of it), at any quality.
  public func isDownloading(_ fileId: Int) -> Bool {
    downloads.contains { OfflineFolder.fileId(ofName: $0.key) == fileId && $0.value.isActive }
  }

  private func finished(_ name: String) {
    if ledger != nil {
      if let d = downloads[name], let id = OfflineFolder.fileId(ofName: name) { report(id, d) }
    } else {
      evict()
    }
    pump()
  }

  private func finishedTransition() {
    evict()
    pump()
  }

  private func report(_ fileId: Int, _ d: Download) {
    let size = (try? d.file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
    ledger?(.completed(fileId: fileId, file: d.file, bytes: Int64(size)))
  }

  private func pump() {
    guard !downloads.values.contains(where: \.isActive), !waiting.isEmpty else { return }
    let (track, quality, request) = waiting.removeFirst()
    _ = download(for: track, quality: quality, request: request)
  }

  private func evict() {
    let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
    guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys) else { return }
    let busy = Set((Array(downloads.values) + Array(transitions.values)).filter(\.isActive).map(\.file))
    // With a ledger, songs are its to drop: only the player's transition files are the cache's.
    let onlyTransitions = ledger != nil
    var entries = files.compactMap { url -> (URL, Date, Int64)? in
      guard !busy.contains(url), !onlyTransitions || url.lastPathComponent.hasPrefix("transition-"), let v = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
      return (url, v.contentModificationDate ?? .distantPast, Int64(v.fileSize ?? 0))
    }
    var total = entries.reduce(0) { $0 + $1.2 }
    entries.sort { $0.1 < $1.1 }
    for (url, _, size) in entries where total > maxBytes {
      try? FileManager.default.removeItem(at: url)
      total -= size
    }
  }
}
