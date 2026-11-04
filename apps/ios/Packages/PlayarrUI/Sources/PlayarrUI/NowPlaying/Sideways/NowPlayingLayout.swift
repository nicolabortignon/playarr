import CoreGraphics

/// How Now Playing is arranged (docs/plans/2026-11-04-ios-now-playing-landscape.md): upright, as a phone held
/// normally; sideways, a phone on its side (the cover on the left, the tracklist on the right, "the sleeve"); or
/// wide, the iPad's desktop layout (the cover beside the song with Up next).
public enum NowPlayingLayout: Equatable, Sendable {
  case upright, sideways, wide

  /// `split`: the window has the iPad's sidebar layout. `compactHeight`: the window's vertical size class is compact
  /// (an iPhone in landscape). At the accessibility text sizes the iPad keeps one column; a phone on its side keeps
  /// the sleeve, with a narrower cover.
  public static func choose(split: Bool, compactHeight: Bool, accessibilitySize: Bool) -> NowPlayingLayout {
    if split { return accessibilitySize ? .upright : .wide }
    return compactHeight ? .sideways : .upright
  }

  /// The sleeve's cover: a square as tall as the window allows, but never so wide that the tracklist gets less than
  /// 300 points (and 36% of the width at the accessibility sizes).
  public static func coverSide(width: CGFloat, height: CGFloat, accessibilitySize: Bool = false) -> CGFloat {
    let byHeight = height - 32
    let byWidth = width * (accessibilitySize ? 0.36 : 0.46)
    let leavesTracklist = width - 28 - 300
    return max(0, min(byHeight, byWidth, leavesTracklist))
  }
}
