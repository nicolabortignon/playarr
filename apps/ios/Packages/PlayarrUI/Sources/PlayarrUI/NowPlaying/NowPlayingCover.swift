import PlayarrAPI
import SwiftUI

/// Now Playing's cover, as an object (plan 7 §3; docs/design.md, Moments; the web's `CoverObject`): paused, it settles
/// back (smaller, its shadow softer) and lifts again on Play, so you can tell from across the room; it tilts up to 2°
/// with the phone, catching a faint sheen on the edge that comes toward you (`tiltsWithPhone`). It settles back without
/// moving, and doesn't tilt, under Reduce Motion.
struct NowPlayingCover: View {
  let track: Track
  let playing: Bool
  @Environment(\.reducesMotion) private var reducesMotion

  /// How far the cover settles back while the music is paused (the web's `PAUSED_SCALE`).
  static let pausedScale = 0.86
  /// Its corners: the web's `rounded-lg`.
  static let corner: CGFloat = 8

  var body: some View {
    Cover(path: track.coverUrl, points: 360, label: track.albumTitle, color: track.coverColor, corner: Self.corner)
      // The shadow eases over half a second, as the web's `transition-shadow duration-500`.
      .coverShadow(playing ? .hero : .shelf)
      .animation(reducesMotion ? nil : .easeOut(duration: 0.5), value: playing)
      .tiltsWithPhone(corner: Self.corner)
      // The web's spring: damping 22, stiffness 180.
      .scaleEffect(playing ? 1 : Self.pausedScale)
      .animation(reducesMotion ? nil : .interpolatingSpring(mass: 1, stiffness: 180, damping: 22), value: playing)
  }
}
