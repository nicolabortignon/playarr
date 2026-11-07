import SwiftUI

#if canImport(UIKit)
  import UIKit
#endif

/// Covers decoded off the main thread and kept decoded (plan 3 §2). Decoded as it was first drawn, each cover held up
/// the main thread while a grid of them scrolled in, and again each time one came back into view. Kept by address, up
/// to 48 MB of pixels; the system empties it when memory runs short.
@MainActor
final class PreparedImages {
  static let shared = PreparedImages()

  #if canImport(UIKit)
    private let cache = NSCache<NSURL, UIImage>()

    init() {
      cache.totalCostLimit = 48 << 20
    }

    /// The image already decoded for `url`, if it's kept.
    func image(for url: URL?) -> Image? {
      url.flatMap { cache.object(forKey: $0 as NSURL) }.map(Image.init(uiImage:))
    }

    /// The image in `data` (JPEG, PNG or WebP), decoded off the main thread and kept for `url`.
    func prepare(_ data: Data, for url: URL?) async -> Image? {
      guard let decoded = UIImage(data: data) else { return nil }
      let ready = await decoded.byPreparingForDisplay() ?? decoded
      if let url, let pixels = ready.cgImage { cache.setObject(ready, forKey: url as NSURL, cost: pixels.bytesPerRow * pixels.height) }
      return Image(uiImage: ready)
    }
  #else
    /// The Mac runs only the package's tests: decoded as it comes, not kept.
    func image(for url: URL?) -> Image? { nil }

    func prepare(_ data: Data, for url: URL?) async -> Image? { Image.decoded(data) }
  #endif
}
