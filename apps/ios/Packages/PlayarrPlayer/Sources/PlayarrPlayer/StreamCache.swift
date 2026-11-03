import Foundation
import PlayarrAPI

/// Songs' own files on disk, fetched ahead of playback: one `Download` per file at a time, shared by whoever reads
/// it. Files are named by file id (`<fileId>.<ext>`, `.part` while incomplete), one folder per server and account
/// (the caller's `directory`). The least recently played go first past `maxBytes`. Keeping songs for offline
/// listening is phase 7's, outside this cache.
public actor StreamCache {
  public let directory: URL
  private let maxBytes: Int64
  private let configuration: @Sendable () -> URLSessionConfiguration
  private let retryDelay: Duration
  private var downloads: [Int: Download] = [:]
  private var transitions: [String: Download] = [:]
  private var waiting: [(Track, URLRequest)] = []

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

  public func file(for track: Track) -> URL { directory.appending(path: "\(track.fileId).\(track.format.container.lowercased())") }

  /// The whole file, if it's here. Marks it as just played.
  public func completedFile(for track: Track) -> URL? {
    let url = file(for: track)
    guard FileManager.default.fileExists(atPath: url.path()) else { return nil }
    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path())
    return url
  }

  /// The download of this song's file, started (or continued from what's here) if it isn't running.
  public func download(for track: Track, request: URLRequest) -> Download {
    if let running = downloads[track.fileId], running.isActive || running.isFinished { return running }
    let final = file(for: track)
    let d = Download(
      request: request, file: final.appendingPathExtension("part"), finalFile: final, retryDelay: retryDelay,
      configuration: configuration)
    d.onFinish { [weak self] in Task { await self?.finished() } }
    downloads[track.fileId] = d
    d.start()
    return d
  }

  /// A DJ transition's file on disk, beside the songs (and dropped with them, least recently played first). `name` is
  /// the last part of its URL: the server names transitions by a hash of what they're made from.
  public func transitionFile(named name: String) -> URL { directory.appending(path: "transition-\(name)") }

  /// The whole transition file, if it's here. Marks it as just played.
  public func completedTransition(named name: String) -> URL? {
    let url = transitionFile(named: name)
    guard FileManager.default.fileExists(atPath: url.path()) else { return nil }
    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path())
    return url
  }

  /// The download of a transition file, started (or continued) if it isn't running. It isn't queued behind the songs
  /// fetched ahead: it's needed by the mix point.
  public func transition(named name: String, request: URLRequest) -> Download {
    if let running = transitions[name], running.isActive || running.isFinished { return running }
    let final = transitionFile(named: name)
    let d = Download(
      request: request, file: final.appendingPathExtension("part"), finalFile: final, retryDelay: retryDelay, configuration: configuration)
    d.onFinish { [weak self] in Task { await self?.finished() } }
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

  public func discard(_ download: Download) {
    download.cancel()
    try? FileManager.default.removeItem(at: download.file)
  }

  /// The songs to fetch ahead, in order (the next 3 on Wi-Fi, 1 on mobile data: see `PrefetchPolicy`): one at a time,
  /// once nothing else is downloading. Replaces the earlier list.
  public func prefetch(_ songs: [(Track, URLRequest)]) {
    waiting = songs.filter { completedFile(for: $0.0) == nil }
    pump()
  }

  /// Stops the downloads of other songs (what's here stays, and continues later).
  public func keepOnly(_ fileIds: Set<Int>) {
    for (id, d) in downloads where !fileIds.contains(id) && !d.isFinished {
      d.cancel()
      downloads[id] = nil
    }
    waiting.removeAll { !fileIds.contains($0.0.fileId) }
  }

  private func finished() {
    evict()
    pump()
  }

  private func pump() {
    guard !downloads.values.contains(where: \.isActive), !waiting.isEmpty else { return }
    let (track, request) = waiting.removeFirst()
    _ = download(for: track, request: request)
  }

  private func evict() {
    let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
    guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys) else { return }
    let busy = Set((Array(downloads.values) + Array(transitions.values)).filter(\.isActive).map(\.file))
    var entries = files.compactMap { url -> (URL, Date, Int64)? in
      guard !busy.contains(url), let v = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
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
