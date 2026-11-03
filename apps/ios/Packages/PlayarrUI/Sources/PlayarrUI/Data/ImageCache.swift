import CryptoKit
import Foundation
import PlayarrAPI

/// Covers and artist photos, per server and account: in memory, on disk, else from the server at one of the sizes it
/// makes (`apps/server/src/routes/art.ts` snaps every `?size=` to these), with the token in the header. A failed
/// image is asked once more after 1.5 s with `&retry=1`, as the web's `Cover` does. When the server's public address
/// can't be reached, its home-network one is tried (`MediaURLs.onLocalAddress`), as `APIClient` does.
public actor ImageCache {
  /// The sizes the server makes (px); asking for one of them hits its cache, and ours.
  public static let sizes = [96, 160, 240, 320, 480, 640, 960, 1200]
  /// Kept for 60 days, at most 1500 images (the web's service worker keeps art the same way).
  public static let maxAge: TimeInterval = 60 * 24 * 60 * 60
  public static let maxFiles = 1500

  /// The size to ask for an image shown `points` wide on a screen of `scale`.
  public static func pixels(points: Double, scale: Double) -> Int {
    let wanted = Int((points * min(max(scale, 1), 3)).rounded(.up))
    return sizes.first { $0 >= wanted } ?? sizes[sizes.count - 1]
  }

  private let directory: URL
  private let media: MediaURLs
  private let session: URLSession
  private let retryDelay: Duration
  private let memory = NSCache<NSURL, NSData>()
  private var inFlight: [URL: Task<Data?, Never>] = [:]

  public init(directory: URL, media: MediaURLs, session: URLSession = .shared, retryDelay: Duration = .milliseconds(1500)) {
    self.directory = directory
    self.media = media
    self.session = session
    self.retryDelay = retryDelay
    memory.totalCostLimit = 64 * 1024 * 1024
  }

  /// The address of `path` (a `coverUrl`, `imageUrl`…) at `size` px; nil without a path.
  public nonisolated func url(_ path: String?, size: Int) -> URL? { media.art(path, size: size) }

  /// The image's bytes (JPEG, PNG or WebP), or nil if there's none or it can't be had.
  public func data(_ path: String?, size: Int) async -> Data? {
    guard let url = url(path, size: size) else { return nil }
    return await data(for: url)
  }

  public func data(for url: URL) async -> Data? {
    if let hit = memory.object(forKey: url as NSURL) { return hit as Data }
    let file = self.file(for: url)
    if let data = try? Data(contentsOf: file) {
      try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
      remember(data, for: url)
      return data
    }
    if let running = inFlight[url] { return await running.value }
    let task = Task { await download(url) }
    inFlight[url] = task
    let data = await task.value
    inFlight[url] = nil
    if let data {
      remember(data, for: url)
      try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try? data.write(to: file, options: .atomic)
    }
    return data
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
    } catch {
      // The public address can't be reached (at home, behind a router that doesn't loop back): the home one.
      guard let local = media.onLocalAddress(url), let fromHome = try? await session.data(for: media.request(for: local)) else { return nil }
      answer = fromHome
    }
    guard (answer.1 as? HTTPURLResponse)?.statusCode == 200, !answer.0.isEmpty else { return nil }
    return answer.0
  }

  private func remember(_ data: Data, for url: URL) {
    memory.setObject(data as NSData, forKey: url as NSURL, cost: data.count)
  }

  private func file(for url: URL) -> URL {
    let digest = SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
    return directory.appending(path: digest)
  }
}
