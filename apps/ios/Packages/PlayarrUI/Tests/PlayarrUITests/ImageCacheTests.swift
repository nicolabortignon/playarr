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

  @Test func triesTheHomeAddressWhenThePublicOneCantBeReached() async {
    let home = "home-\(UUID().uuidString.lowercased()).invalid"
    // The public host has no handler: FakeServer fails it as an unreachable host.
    let session = FakeServer.session(host: home) { request in (200, "from home \(request.value(forHTTPHeaderField: "Authorization") ?? "")") }
    let media = MediaURLs(baseURL: URL(string: "https://\(host)")!, localURL: URL(string: "http://\(home)")!, token: "tok")
    let images = ImageCache(directory: directory, media: media, session: session, retryDelay: .zero)
    #expect(await images.data("/art/album/70/cover", size: 96) == Data("from home Bearer tok".utf8))
  }
}
