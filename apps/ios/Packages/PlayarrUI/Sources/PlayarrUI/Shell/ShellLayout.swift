import CoreGraphics

/// Which chrome a window gets: the phone's tabs, or the desktop web's sidebar, page and player bar
/// (apps/web/src/components/AppShell.tsx mounts one or the other at Tailwind's `md`, 768 px).
public enum ShellLayout: String, Hashable, Sendable, Codable {
  case tabs, split

  /// The web's desktop breakpoint. An iPad window narrower than this (Slide Over, a third or half of the screen in
  /// Split View, a small Stage Manager window, an iPad mini held upright) gets the phone's tabs.
  public static let splitMinWidth: CGFloat = 768

  /// `regularWidth` is the window's horizontal size class being regular (always false on an iPhone).
  public static func choose(regularWidth: Bool, width: CGFloat) -> ShellLayout {
    regularWidth && width >= splitMinWidth ? .split : .tabs
  }

  /// How far up the window's foot a keyboard reaches before the player bar steps aside: a software keyboard takes
  /// hundreds of points, while the home indicator takes 20 and a hardware keyboard's shortcuts bar a few dozen.
  public static let keyboardReach: CGFloat = 120

  /// Whether the iPad's player bar steps aside, from the window's bottom safe area (`bottomInset`, which takes in a
  /// keyboard while one is up): while typing on the screen's keyboard, as the phone's tab bar and mini player do, so
  /// what's typed keeps its results in view rather than two rows between the bar and the keys.
  public static func barStepsAside(bottomInset: CGFloat) -> Bool {
    bottomInset > keyboardReach
  }
}
