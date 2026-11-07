import PlayarrAPI
import SwiftUI

/// Now Playing's cover, as an object (plan 7 §3; docs/design.md, Moments; the web's `CoverObject`): paused, it settles
/// back (smaller, its shadow softer) and lifts again on Play, so you can tell from across the room; it tilts up to 2°
/// with the phone (`CoverTilt`), catching a faint sheen on the edge that comes toward you. It settles back without
/// moving, and doesn't tilt, under Reduce Motion.
struct NowPlayingCover: View {
  let track: Track
  let playing: Bool
  @Environment(\.reducesMotion) private var reducesMotion
  @Environment(\.scenePhase) private var scenePhase
  @State private var tilt = CoverTilt()

  /// How far the cover settles back while the music is paused (the web's `PAUSED_SCALE`).
  static let pausedScale = 0.86
  /// Its corners: the web's `rounded-lg`.
  static let corner: CGFloat = 8

  var body: some View {
    let lean = reducesMotion ? CoverTilt.Lean() : tilt.lean
    Cover(path: track.coverUrl, points: 360, label: track.albumTitle, color: track.coverColor, corner: Self.corner)
      .overlay { Self.sheen(lean) }
      .clipShape(RoundedRectangle(cornerRadius: Self.corner))
      // The shadow eases over half a second, as the web's `transition-shadow duration-500`.
      .coverShadow(playing ? .hero : .shelf)
      .animation(reducesMotion ? nil : .easeOut(duration: 0.5), value: playing)
      .rotation3DEffect(.degrees(-lean.h * CoverTilt.maxDegrees), axis: (x: 0, y: 1, z: 0))
      .rotation3DEffect(.degrees(-lean.v * CoverTilt.maxDegrees), axis: (x: 1, y: 0, z: 0))
      // The web's spring: damping 22, stiffness 180.
      .scaleEffect(playing ? 1 : Self.pausedScale)
      .animation(reducesMotion ? nil : .interpolatingSpring(mass: 1, stiffness: 180, damping: 22), value: playing)
      // The gyroscope only while the cover can be seen: the music plays on with the screen off, and so would it.
      .onAppear { follow(scenePhase == .active && !reducesMotion) }
      .onDisappear { tilt.stop() }
      .onChange(of: scenePhase == .active && !reducesMotion) { _, on in follow(on) }
  }

  private func follow(_ on: Bool) {
    on ? tilt.start() : tilt.stop()
  }

  /// A soft light on the edge leaning toward you, as strong as the lean: paper at 22 % fading out (the web's).
  private static func sheen(_ lean: CoverTilt.Lean) -> some View {
    EllipticalGradient(
      colors: [Color.paper.opacity(0.22), .clear], center: UnitPoint(x: 0.5 + 0.5 * lean.h, y: 0.5 - 0.5 * lean.v),
      startRadiusFraction: 0, endRadiusFraction: 0.75
    )
    .opacity(lean.amount)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}
