import Foundation
import Observation
import PlayarrAPI
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

  /// What the song playing's accent comes from: when any of it changes, the accent follows the song again.
  struct Source: Hashable {
    let coverUrl: String?
    let coverAccent: String?
    let coverColor: String?

    init(_ track: Track?) {
      coverUrl = track?.coverUrl
      coverAccent = track?.coverAccent
      coverColor = track?.coverColor
    }
  }

  /// How long the accent takes to glide to a new song's color without its tempo (the web's `ACCENT_GLIDE_S`)…
  public static let glideWithoutTempo = 0.8
  /// …and with it, one beat, kept between these (a misread tempo shouldn't make it snap or crawl).
  public static let glideRange = 0.3...1.2

  /// How long the accent glides to a song's color (plan 7 §1): one beat of it when its tempo is known. As the web's
  /// `accentGlide` (lib/accent.ts).
  public static func glide(bpm: Double?) -> Double {
    guard let bpm, bpm > 0 else { return glideWithoutTempo }
    return min(glideRange.upperBound, max(glideRange.lowerBound, 60 / bpm))
  }

  /// The accent a cover gives, when the server has read it: its `coverAccent`; .some(nil) when it has and the cover
  /// has none to give (a `coverColor` without a `coverAccent`: a gray or black-and-white cover, which gets Playarr's
  /// orange); nil when it hasn't (an older server, a cover not read yet), and the picture is read here. As the web's
  /// `knownAccent` (lib/color.ts).
  public static func knownAccent(coverAccent: String?, coverColor: String?) -> RGB?? {
    if let accent = RGB(css: coverAccent) { return .some(accent) }
    return coverColor == nil ? nil : .some(nil)
  }

  /// Follows the song playing (docs/design.md, Moments): its `coverAccent` at once, so the color changes with the song
  /// before its cover has loaded; read from the cover only where the server hasn't read it. It glides there over one
  /// beat of the song (`bpm`, its tempo when known, `glide(bpm:)`), at once under Reduce Motion.
  public func follow(_ track: Track?, bpm: Double?, images: ImageCache?, reduceMotion: Bool) async {
    let path = track?.coverUrl
    following = path
    let color: RGB? =
      switch Self.knownAccent(coverAccent: track?.coverAccent, coverColor: track?.coverColor) {
      case .some(let known): known
      case nil: await accent(of: path, images: images)
      }
    guard following == path, color != coverAccent else { return }
    // The web's CSS `ease`.
    withAnimation(reduceMotion ? nil : .timingCurve(0.25, 0.1, 0.25, 1, duration: Self.glide(bpm: bpm))) { coverAccent = color }
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
