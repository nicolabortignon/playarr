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
}
