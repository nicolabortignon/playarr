import CoreGraphics

/// How Now Playing is arranged (docs/ios/layouts.md): upright, as a phone held
/// normally; sideways, a phone on its side ("the sleeve": the record on the left, the cover with the deck under it for
/// the left thumb, and the tracklist on the right, the full height, for the right); or wide, the iPad's desktop layout
/// (the cover beside the song with Up next).
public enum NowPlayingLayout: Equatable, Sendable {
  case upright, sideways, wide
  /// An iPhone Duo open with the crease down the middle (flat, or held like a book): two pages, the cover on the left
  /// one, the song, its controls and Up next on the right, so the crease falls between them.
  case pages
  /// An iPhone Duo propped up part-open like a small laptop, the crease across the middle: the cover (or lyrics) on
  /// the half that stands, the song, its controls and Up next on the half that lies flat, under the thumbs.
  case desk

  /// `split`: the window has the iPad's sidebar layout. `compactHeight`: the window's vertical size class is compact
  /// (an iPhone in landscape). At the accessibility text sizes the iPad keeps one column; a phone on its side keeps
  /// the sleeve, with a narrower cover. `fold`: an iPhone Duo's hinge, whose crease comes first; `wider`: the window is
  /// wider than tall (the crease then runs down it).
  public static func choose(
    split: Bool, compactHeight: Bool, accessibilitySize: Bool, fold: Fold = .none, wider: Bool = false
  ) -> NowPlayingLayout {
    switch fold {
    case .flat where wider, .half where wider: return .pages
    case .half: return .desk
    default: break
    }
    if split { return accessibilitySize ? .upright : .wide }
    return compactHeight ? .sideways : .upright
  }

  /// The deck under the sleeve's cover (the seek bar, then shuffle, previous, play or pause, next and repeat): the room
  /// it takes, so the cover is as large as what's left.
  public static let deckWidth: CGFloat = 264
  public static let deckHeight: CGFloat = 108

  /// The record's column: as wide as the cover can be once the deck under it has its height (`deck`: 0 in the stage,
  /// where the deck is gone and the cover grows), at least as wide as the deck, at most 42% of the width (36% at the
  /// accessibility sizes), and never so wide that the tracklist gets less than 300 points.
  public static func recordWidth(width: CGFloat, height: CGFloat, deck: CGFloat, accessibilitySize: Bool = false) -> CGFloat {
    let byHeight = max(height - deck - 16, deck > 0 ? deckWidth : 0)
    let byWidth = width * (accessibilitySize ? 0.36 : 0.42)
    let leavesTracklist = width - 28 - 300
    return max(0, min(byHeight, byWidth, leavesTracklist))
  }
}
