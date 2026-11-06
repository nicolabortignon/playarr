import Foundation
import Observation
import SwiftUI

/// The accent colour: Playarr's orange, a fixed colour, or (by default) one taken from the cover of the song playing,
/// with the web's algorithm (`AccentColor`). Album pages tint their header with their own cover's colour.
@MainActor @Observable
public final class Theme {
  /// Playarr's orange, when a cover has no colour to give.
  public static let defaultAccent = RGB(hex: 0xff7a1a)
  /// Covers are read at this size (px), as the web reads them at 96.
  public static let sampleSize = 96

  public let appearance: AppearanceSettings
  /// The colour of the cover playing, when it has one.
  public private(set) var coverAccent: RGB?

  @ObservationIgnored private var known: [String: RGB?] = [:]
  @ObservationIgnored private var following: String?

  public init(appearance: AppearanceSettings) {
    self.appearance = appearance
  }

  /// The accent to use now.
  public var accent: RGB {
    switch appearance.accent {
    case .album: coverAccent ?? Self.defaultAccent
    case .fixed(let color): color.rgb
    }
  }

  /// A row of the system's lists and forms in a sheet (#2C2C2E), the lighter of their two: on a page they're #1C1C1E.
  public static let listRow = RGB(hex: 0x2c2c2e)

  /// The accent as text in the system's lists and forms (Settings, and the sheets it opens). It's lifted to read on
  /// the page, and their rows are lighter (an accent at the page's floor reads 4.1:1 on #1C1C1E), so there it's lifted
  /// until it reads 4.5:1 on a sheet's row. An accent that reads there already, like Playarr's orange, is unchanged.
  public var listAccent: RGB { AccentColor.legible(accent, on: Self.listRow) }

  /// Follows the song playing: its cover's colour becomes the accent.
  public func follow(cover path: String?, images: ImageCache?) async {
    following = path
    let color = await accent(of: path, images: images)
    if following == path { coverAccent = color }
  }

  /// `accent(of:images:)` when the cover has been read already, without waiting: .some(nil) when it has no colour,
  /// nil when it hasn't been read.
  public func knownAccent(of path: String) -> RGB?? {
    known[path]
  }

  /// The colour of a cover (nil when it has none), read once per cover.
  public func accent(of path: String?, images: ImageCache?) async -> RGB? {
    guard let path else { return nil }
    if let seen = known[path] { return seen }
    guard let images, let data = await images.data(path, size: Self.sampleSize) else { return nil }
    let color = await Task.detached { AccentColor.extract(imageData: data)?.rgb }.value
    known[path] = color
    return color
  }
}
