import Foundation
import ImageIO
import PlayarrAPI
import SwiftUI
import UniformTypeIdentifiers

extension WidgetPublisher.Art {
  /// How wide a cover is drawn on a widget, in points, at most: a large widget's tile.
  static let points: CGFloat = 128

  /// The account's: album covers from its image cache, mix covers drawn by Home's `MixCover` (without its title, which
  /// the widget sets beneath) with their album covers handed over loaded, as a picture drawn once can't wait for them.
  /// The wash Vibes, Discovery and On Repeat take from their covers' colors comes out as the mix's own color.
  public static func live(session: AccountSession, theme: Theme) -> Self {
    let size = ImageCache.pixels(points: points, scale: 2)
    return Self(
      albumCover: { path in await session.images.data(path, size: size) },
      mixCover: { mix in
        var presets: [String: Image] = [:]
        for path in mix.covers.prefix(4) {
          if let data = await session.images.data(path, size: size), let picture = CGImage.decoded(data) {
            presets[path] = Image(decorative: picture, scale: 1)
          }
        }
        let renderer = ImageRenderer(
          content: MixCover(mix: mix, width: points, titled: false)
            .environment(theme)
            .environment(session)
            .environment(\.presetCovers, presets))
        renderer.scale = 2
        return renderer.cgImage?.jpegData
      })
  }
}

extension CGImage {
  static func decoded(_ data: Data) -> CGImage? {
    CGImageSourceCreateWithData(data as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) }
  }

  /// As a JPEG, for a widget's cover.
  var jpegData: Data? {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, self, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    return CGImageDestinationFinalize(destination) ? data as Data : nil
  }
}
