import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrUI

@Suite struct ImageCacheTests {
  let host = "img-\(UUID().uuidString.lowercased()).invalid"
  let directory = FileManager.default.temporaryDirectory.appending(path: "images-\(UUID().uuidString)", directoryHint: .isDirectory)

  func cache(_ handler: @escaping FakeServer.Handler) -> ImageCache {
    let media = MediaURLs(baseURL: URL(string: "http://\(host)")!, token: "tok")
    return ImageCache(directory: directory, media: media, session: FakeServer.session(host: host, handler), retryDelay: .zero)
  }

  @Test func asksForTheSizesTheServerMakes() {
    #expect(ImageCache.pixels(points: 44, scale: 3) == 160)
    #expect(ImageCache.pixels(points: 160, scale: 2) == 320)
    #expect(ImageCache.pixels(points: 320, scale: 3) == 960)
    #expect(ImageCache.pixels(points: 600, scale: 3) == 1200)
  }

  @Test func sendsTheTokenAndKeepsTheImageOnDisk() async {
    let asked = Mutex<[String]>([])
    let images = cache { request in
      asked.withLock { $0.append("\(request.url!.path())?\(request.url!.query() ?? "") \(request.value(forHTTPHeaderField: "Authorization") ?? "")") }
      return (200, "jpeg bytes")
    }
    #expect(await images.data("/art/album/70/cover", size: 320) == Data("jpeg bytes".utf8))
    #expect(asked.withLock { $0 } == ["/art/album/70/cover?size=320 Bearer tok"])

    // A new cache (the next launch) finds it on disk without asking.
    let next = cache { _ in (500, "") }
    #expect(await next.data("/art/album/70/cover", size: 320) == Data("jpeg bytes".utf8))
  }

  func cache(keptIn kept: URL, _ handler: @escaping FakeServer.Handler) -> ImageCache {
    let media = MediaURLs(baseURL: URL(string: "http://\(host)")!, token: "tok")
    return ImageCache(directory: directory, keptDirectory: kept, media: media, session: FakeServer.session(host: host, handler), retryDelay: .zero)
  }

  @Test func keepsDownloadsCoversWhereTheSystemDoesntEmptyAndShowsThemOfflineAtAnySize() async throws {
    let kept = FileManager.default.temporaryDirectory.appending(path: "kept-\(UUID().uuidString)", directoryHint: .isDirectory)
    let asked = Mutex<[String]>([])
    let online = cache(keptIn: kept) { request in
      asked.withLock { $0.append(request.url!.query() ?? "") }
      return (200, "cover \(request.url!.query() ?? "")")
    }
    await online.setKept(["/art/album/70/cover": ImageCache.keptCoverSize, "/art/album/71/cover": ImageCache.keptRowSize])
    #expect(asked.withLock { $0 }.sorted() == ["size=160", "size=480"])
    // Kept already: not asked again.
    await online.setKept(["/art/album/70/cover": ImageCache.keptCoverSize, "/art/album/71/cover": ImageCache.keptRowSize])
    #expect(asked.withLock { $0.count } == 2)

    // The system emptied Caches; offline, the kept cover stands in at whatever size a page asks for.
    try? FileManager.default.removeItem(at: directory)
    let offline = cache(keptIn: kept) { _ in (503, "") }
    await offline.setKept(["/art/album/70/cover": ImageCache.keptCoverSize, "/art/album/71/cover": ImageCache.keptRowSize])
    #expect(await offline.data("/art/album/70/cover", size: 960) == Data("cover size=480".utf8))
    #expect(await offline.data("/art/album/70/cover", size: 160) == Data("cover size=480".utf8))
    #expect(await offline.data("/art/album/71/cover", size: 320) == Data("cover size=160".utf8))
    // Not a download's: nothing to stand in.
    #expect(await offline.data("/art/album/72/cover", size: 320) == nil)

    // A download removed: its covers go.
    await offline.setKept(["/art/album/71/cover": ImageCache.keptRowSize])
    #expect(await offline.data("/art/album/70/cover", size: 480) == nil)
    let left = try FileManager.default.contentsOfDirectory(atPath: kept.path(percentEncoded: false))
    #expect(left.count == 1)
  }

  @Test func triesOnceMoreAfterAFailure() async {
    let asked = Mutex(0)
    let images = cache { request in
      asked.withLock { $0 += 1 }
      return request.url!.query()!.contains("retry=1") ? (200, "second time") : (503, "")
    }
    #expect(await images.data("/art/album/70/cover", size: 96) == Data("second time".utf8))
    #expect(asked.withLock { $0 } == 2)
  }

  @Test func givesUpAfterTheRetry() async {
    let images = cache { _ in (404, "") }
    #expect(await images.data("/art/album/70/cover", size: 96) == nil)
    #expect(await images.data(nil, size: 96) == nil)
  }

  @Test func prunesWhatWasntUsedFor60Days() async throws {
    let images = cache { _ in (200, "bytes") }
    _ = await images.data("/art/album/70/cover", size: 96)
    await images.prune(now: Date().addingTimeInterval(ImageCache.maxAge + 60))
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
  }

  /// The image cache of a server at `https://<host>` (no handler: FakeServer fails it as an unreachable host), whose
  /// home address `home` answers with `handler`.
  func cache(home: String, _ handler: @escaping FakeServer.Handler) -> ImageCache {
    let session = FakeServer.session(host: home, handler)
    let address = HomeAddress(url: URL(string: "http://\(home)")!, token: "tok", session: session, network: LocalNetwork(isLocal: true))
    let media = MediaURLs(baseURL: URL(string: "https://\(host)")!, home: address, token: "tok")
    return ImageCache(directory: directory, media: media, session: session, retryDelay: .zero)
  }

  @Test func triesTheHomeAddressWhenThePublicOneCantBeReached() async {
    // The server itself at home: it proves it holds the session first.
    let images = cache(home: "home-\(UUID().uuidString.lowercased()).invalid") { request in
      FakeServer.proof(request, holding: ["tok"]) ?? (200, "from home \(request.value(forHTTPHeaderField: "Authorization") ?? "")")
    }
    #expect(await images.data("/art/album/70/cover", size: 96) == Data("from home Bearer tok".utf8))
  }

  @Test func neverSendsTheTokenToAHomeAddressThatCantProveIt() async {
    // Something else at the home address (a café's network), which would answer any request with a picture.
    let asked = Mutex<[String]>([])
    let images = cache(home: "home-\(UUID().uuidString.lowercased()).invalid") { request in
      asked.withLock { $0.append("\(request.url!.path()) \(request.value(forHTTPHeaderField: "Authorization") ?? "")") }
      return request.url!.path() == "/api/auth/proof" ? (404, "") : (200, "a picture")
    }
    #expect(await images.data("/art/album/70/cover", size: 96) == nil)
    #expect(asked.withLock { $0 } == ["/api/auth/proof "])
  }
}
