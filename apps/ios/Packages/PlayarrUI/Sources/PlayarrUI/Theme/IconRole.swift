import SwiftUI

/// Icon sizes by role, with the web's (docs/design.md, Icons). Symbols mostly take a text style's size and grow with
/// Dynamic Type; these are for a glyph inside something of a fixed size that doesn't grow (a play button's circle, a
/// cover), which a growing glyph would spill out of. The phone's tab bar is the system's, which sizes its own.
public enum IconRole: Sendable {
  /// 12: inside a badge.
  case badge
  /// 14: beside a line of small text or meta; Home's play and pause over a cover.
  case small
  /// 16: menu items and small buttons.
  case menu
  /// 18: a row's ♥ and ⋯, the player bar's and the mini player's play and pause.
  case toolbar
  /// 20: round icon buttons and large buttons; play and pause in the sideways deck.
  case iconButton
  /// 24: an empty or error state's ring.
  case state
  /// 28: Now Playing's previous and next.
  case transport
  /// 32: play and pause in Now Playing's 72-point circle.
  case play

  public var points: CGFloat {
    switch self {
    case .badge: 12
    case .small: 14
    case .menu: 16
    case .toolbar: 18
    case .iconButton: 20
    case .state: 24
    case .transport: 28
    case .play: 32
    }
  }
}

extension Font {
  /// A symbol at its role's size, fixed (`IconRole`): for a glyph in a circle or over a cover that doesn't grow.
  public static func icon(_ role: IconRole, weight: Font.Weight = .regular) -> Font {
    .system(size: role.points, weight: weight)
  }
}
