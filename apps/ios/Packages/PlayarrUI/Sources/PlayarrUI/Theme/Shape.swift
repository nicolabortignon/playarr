import SwiftUI

/// Corner radii, by role, with the web's names (`rounded-cover`…, docs/design.md). Pills and round buttons are a
/// `Capsule` or a `Circle`.
public enum Radius {
  /// Covers and thumbnails.
  public static let cover: CGFloat = 4
  /// A place's icon on its tile (Library's rows) and the accent swatches: the web's `rounded-md`.
  public static let tile: CGFloat = 6
  /// Panels and cards.
  public static let panel: CGFloat = 12
  /// Dialogs and sheets.
  public static let dialog: CGFloat = 16
}

/// The two cover shadows: a cover on a shelf or in a grid, and a page's own cover (the web's `shadow-cover` and
/// `shadow-cover-hero`).
public enum CoverShadow: Sendable {
  case shelf, hero
}

extension View {
  public func coverShadow(_ shadow: CoverShadow) -> some View {
    let (opacity, radius, y): (Double, CGFloat, CGFloat) =
      switch shadow {
      case .shelf: (0.5, 10, 6)
      case .hero: (0.7, 28, 18)
      }
    return self.shadow(color: .black.opacity(opacity), radius: radius, y: y)
  }
}

/// How long things take (docs/design.md): the web's `duration-150` and `duration-250`. Covers fading in and the
/// accent following the cover take longer on purpose.
public enum Motion {
  /// A press, a color changing.
  public static let fast: Animation = .easeOut(duration: 0.15)
  /// Things that move or change size: menus, toasts, rows.
  public static let standard: Animation = .snappy(duration: 0.25)
}
