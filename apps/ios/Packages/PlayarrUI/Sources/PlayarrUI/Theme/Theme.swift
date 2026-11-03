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

  /// Follows the song playing: its cover's colour becomes the accent.
  public func follow(cover path: String?, images: ImageCache?) async {
    following = path
    let color = await accent(of: path, images: images)
    if following == path { coverAccent = color }
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
