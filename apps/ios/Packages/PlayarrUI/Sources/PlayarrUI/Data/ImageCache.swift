import CryptoKit
import Foundation
import PlayarrAPI

/// Covers and artist photos, per server and account: in memory, on disk, else from the server at one of the sizes it
/// makes (`apps/server/src/routes/art.ts` snaps every `?size=` to these), with the token in the header. A failed
/// image is asked once more after 1.5 s with `&retry=1`, as the web's `Cover` does. When the server's public address
/// can't be reached, its home-network one is tried once the server there has proven itself on this network
/// (`MediaURLs.onHomeAddress`), as `APIClient` does.
///
/// Downloads' covers are kept apart (`keptDirectory`, in Application Support, which the system never empties, as it
/// may Caches): each fetched at the size its download's pages show it (`PinnedDownload.keptCovers`), and kept at
/// whatever sizes were shown since. Offline, a kept cover stands in at the sizes it wasn't kept at, so a download's
/// pages always show their covers.
public actor ImageCache {
  /// The sizes the server makes (px); asking for one of them hits its cache, and ours.
  public static let sizes = [96, 160, 240, 320, 480, 640, 960, 1200]
  /// Kept for 60 days, at most 1500 images (the web's service worker keeps art the same way).
  public static let maxAge: TimeInterval = 60 * 24 * 60 * 60
  public static let maxFiles = 1500
  /// The sizes downloads' covers are fetched at: a download's own (a tile's on a phone, 160 points at 3x), its songs'
  /// (a row's), drawn larger or smaller offline.
  public static let keptCoverSize = 480
  public static let keptRowSize = 160

  /// The size to ask for an image shown `points` wide on a screen of `scale`.
  public static func pixels(points: Double, scale: Double) -> Int {
    let wanted = Int((points * min(max(scale, 1), 3)).rounded(.up))
    return sizes.first { $0 >= wanted } ?? sizes[sizes.count - 1]
  }

  private let directory: URL
  /// Downloads' covers, by path and size (`keptFile`); nil keeps none.
  private let keptDirectory: URL?
  /// The paths of downloads' covers.
  private var kept: Set<String> = []
  private let media: MediaURLs
  private let session: URLSession
  private let retryDelay: Duration
  private let memory = NSCache<NSURL, NSData>()
  private var inFlight: [URL: Task<Data?, Never>] = [:]

  public init(
    directory: URL, keptDirectory: URL? = nil, media: MediaURLs, session: URLSession = .shared, retryDelay: Duration = .milliseconds(1500)
  ) {
    self.directory = directory
    self.keptDirectory = keptDirectory
    self.media = media
    self.session = session
    self.retryDelay = retryDelay
    memory.totalCostLimit = 64 * 1024 * 1024
  }

  /// The address of `path` (a `coverUrl`, `imageUrl`…) at `size` px; nil without a path.
  public nonisolated func url(_ path: String?, size: Int) -> URL? { media.art(path, size: size) }

  /// The image's bytes (JPEG, PNG or WebP), or nil if there's none or it can't be had. A download's cover is kept, and
  /// offline one kept at another size stands in.
  public func data(_ path: String?, size: Int) async -> Data? {
    guard let path, let url = url(path, size: size) else { return nil }
    let keep = kept.contains(path) ? keptFile(path, size: size) : nil
    if let data = await data(for: url, keepingAt: keep) { return data }
    return keep == nil ? nil : keptCopy(path, near: size)
  }

  /// The covers of downloads, each with the size their pages show it at (`PinnedDownload.keptCovers`): kept from now
  /// on, each fetched at that size if it isn't kept at it or bigger; those of downloads removed go.
  public func setKept(_ covers: [String: Int]) async {
    guard let keptDirectory else { return }
    let paths = Set(covers.keys)
    let gone = kept.subtracting(paths)
    kept = paths
    if !gone.isEmpty {
      let prefixes = Set(gone.map { Self.digest($0) })
      let files = (try? FileManager.default.contentsOfDirectory(atPath: keptDirectory.path(percentEncoded: false))) ?? []
      for name in files where prefixes.contains(String(name.prefix { $0 != "-" })) {
        try? FileManager.default.removeItem(at: keptDirectory.appending(path: name))
      }
    }
    for (path, size) in covers.sorted(by: { $0.key < $1.key }) where kept.contains(path) && keptSizes(path).last.map({ $0 < size }) ?? true {
      guard !Task.isCancelled else { return }
      _ = await data(path, size: size)
    }
  }

  /// An image as the server has it, not resized: an artist's logo, whose transparency a resize could lose.
  public func original(_ path: String?) async -> Data? {
    guard let path, let url = media.url(path) else { return nil }
    return await data(for: url)
  }

  public func data(for url: URL) async -> Data? { await data(for: url, keepingAt: nil) }

  /// From memory, the kept file, the cache's, else the server; written to `keep` when it's a download's cover (moved
  /// there from the cache's), else to the cache's file.
  private func data(for url: URL, keepingAt keep: URL?) async -> Data? {
    if let hit = memory.object(forKey: url as NSURL) {
      if let keep { write(hit as Data, to: keep, ifMissing: true) }
      return hit as Data
    }
    if let keep, let data = try? Data(contentsOf: keep) {
      remember(data, for: url)
      return data
    }
    let file = self.file(for: url)
    if let data = try? Data(contentsOf: file) {
      try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
      remember(data, for: url)
      if let keep { write(data, to: keep, ifMissing: true) }
      return data
    }
    if let running = inFlight[url] { return await running.value }
    let task = Task { await download(url) }
    inFlight[url] = task
    let data = await task.value
    inFlight[url] = nil
    if let data {
      remember(data, for: url)
      write(data, to: keep ?? file, ifMissing: false)
    }
    return data
  }

  private func write(_ data: Data, to file: URL, ifMissing: Bool) {
    if ifMissing, FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) { return }
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: file, options: .atomic)
  }

  /// A download's cover kept at `size`: `<digest of its path>-<size>`.
  private func keptFile(_ path: String, size: Int) -> URL? {
    keptDirectory?.appending(path: "\(Self.digest(path))-\(size)")
  }

  /// A download's cover kept at the size nearest `size`: the smallest bigger one, else the biggest.
  private func keptCopy(_ path: String, near size: Int) -> Data? {
    let sizes = keptSizes(path)
    guard let best = sizes.first(where: { $0 >= size }) ?? sizes.last, let file = keptFile(path, size: best) else { return nil }
    return try? Data(contentsOf: file)
  }

  /// The sizes a download's cover is kept at, smallest first.
  private func keptSizes(_ path: String) -> [Int] {
    guard let keptDirectory else { return [] }
    let prefix = "\(Self.digest(path))-"
    let files = (try? FileManager.default.contentsOfDirectory(atPath: keptDirectory.path(percentEncoded: false))) ?? []
    return files.compactMap { $0.hasPrefix(prefix) ? Int($0.dropFirst(prefix.count)) : nil }.sorted()
  }

  /// Fetches images about to be shown.
  public func prefetch(_ paths: [String?], size: Int) {
    for path in paths {
      guard let url = url(path, size: size), memory.object(forKey: url as NSURL) == nil else { continue }
      Task { _ = await data(for: url) }
    }
  }

  /// Drops images unused for 60 days, then the least recently used beyond 1500.
  public func prune(now: Date = Date()) {
    let key = URLResourceKey.contentModificationDateKey
    let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [key])) ?? []
    let dated = files.map { ($0, (try? $0.resourceValues(forKeys: [key]))?.contentModificationDate ?? .distantPast) }
      .sorted { $0.1 > $1.1 }
    for (index, (file, modified)) in dated.enumerated() where index >= Self.maxFiles || now.timeIntervalSince(modified) > Self.maxAge {
      try? FileManager.default.removeItem(at: file)
    }
  }

  private func download(_ url: URL) async -> Data? {
    if let data = await get(url) { return data }
    try? await Task.sleep(for: retryDelay)
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "retry", value: "1")]
    guard let retry = components.url else { return nil }
    return await get(retry)
  }

  private func get(_ url: URL) async -> Data? {
    let answer: (Data, URLResponse)
    do {
      answer = try await session.data(for: media.request(for: url))
    } catch let error as URLError where APIClient.couldntConnect(error) {
      // The public address can't be reached (at home, behind a router that doesn't loop back): the home one, if the
      // server there has proven itself on this network.
      guard let local = await media.onHomeAddress(url), let fromHome = try? await session.data(for: media.request(for: local)) else { return nil }
      answer = fromHome
    } catch {
      return nil
    }
    guard (answer.1 as? HTTPURLResponse)?.statusCode == 200, !answer.0.isEmpty else { return nil }
    return answer.0
  }

  private func remember(_ data: Data, for url: URL) {
    memory.setObject(data as NSData, forKey: url as NSURL, cost: data.count)
  }

  private func file(for url: URL) -> URL { directory.appending(path: Self.digest(url.absoluteString)) }

  private static func digest(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}
