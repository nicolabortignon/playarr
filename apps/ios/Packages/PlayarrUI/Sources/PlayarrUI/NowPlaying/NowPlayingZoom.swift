import SwiftUI

extension EnvironmentValues {
  /// Where the player's cover and Now Playing find each other, so the one grows into the other (`NowPlayingZoom`). Set
  /// by the shell.
  @Entry var nowPlayingZoom: Namespace.ID?
}

/// The player's cover grows into Now Playing, and Now Playing shrinks back into it as it closes (plan 7 §1;
/// docs/design.md, Moments): the system's zoom, from the mini player's cover or the iPad bar's. Under Reduce Motion
/// Now Playing comes up as it always has.
enum NowPlayingZoom {
  /// The one source: only one player's cover shows at a time.
  static let source = "playerCover"
}

extension View {
  /// The player's cover (the mini player's, the iPad bar's), as where Now Playing grows from: `corner` is the radius
  /// it's drawn with, so the zoom starts from its shape (half its side for a round one).
  func nowPlayingZoomSource(corner: CGFloat) -> some View {
    modifier(NowPlayingZoomSource(corner: corner))
  }

  /// Now Playing, growing out of the player's cover and shrinking back into it.
  func growsFromPlayerCover(in namespace: Namespace.ID, reduceMotion: Bool) -> some View {
    modifier(GrowsFromPlayerCover(namespace: namespace, reduceMotion: reduceMotion))
  }
}

private struct NowPlayingZoomSource: ViewModifier {
  let corner: CGFloat
  @Environment(\.nowPlayingZoom) private var namespace

  func body(content: Content) -> some View {
    if let namespace {
      content.matchedTransitionSource(id: NowPlayingZoom.source, in: namespace) { $0.clipShape(RoundedRectangle(cornerRadius: corner)) }
    } else {
      content
    }
  }
}

private struct GrowsFromPlayerCover: ViewModifier {
  let namespace: Namespace.ID
  let reduceMotion: Bool

  func body(content: Content) -> some View {
    #if os(iOS)
      if reduceMotion {
        content
      } else {
        // The zoom only opens and closes it: the system's own drag to close it (a shrinking card) would be a second way
        // to close it beside Now Playing's slide down, depending on where the finger lands.
        content.navigationTransition(.zoom(sourceID: NowPlayingZoom.source, in: namespace)).interactiveDismissDisabled()
      }
    #else
      content
    #endif
  }
}
