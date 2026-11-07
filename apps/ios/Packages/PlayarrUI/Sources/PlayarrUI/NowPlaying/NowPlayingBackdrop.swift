import Foundation
import PlayarrAPI
import SwiftUI

/// Now Playing's atmosphere: the cover itself, blown up and blurred, drifting slowly through its own colors, 40 seconds
/// each way (plan 7 §3; docs/design.md, Moments; the web's `Backdrop` and index.css's `drift`); a new song's cover
/// fades in over the last. Still, and changing at once, under Reduce Motion.
struct NowPlayingBackdrop: View {
  let track: Track
  @Environment(\.reducesMotion) private var reducesMotion
  /// When the drift began: the pose is worked out from the time since.
  @State private var start = Date()

  /// How often the drift moves on, in seconds. At its fastest it turns 2.6° a second, under a 90-point blur: a step of
  /// a quarter of a degree can't be told from a smooth turn, and ten steps a second cost a sixth of sixty (Now Playing
  /// may stay open for hours, sideways on a stand).
  static let step = 0.1

  var body: some View {
    ZStack {
      Color.black
      TimelineView(.animation(minimumInterval: Self.step, paused: reducesMotion), content: Self.drifting(blurred, since: start, still: reducesMotion))
        .animation(reducesMotion ? nil : .easeInOut(duration: 1.2), value: track.coverUrl)
      RadialGradient(colors: [.clear, .black.opacity(0.5), .black.opacity(0.92)], center: .top, startRadius: 0, endRadius: 700)
      // A dark wash over it all, so words stay readable over a bright cover.
      Color.black.opacity(0.3)
    }
    .ignoresSafeArea()
    .accessibilityHidden(true)
  }

  private var blurred: some View {
    Cover(path: track.coverUrl, points: 300, color: track.coverColor).scaleEffect(1.5).blur(radius: 90).opacity(0.55).saturation(1.5)
      .id(track.coverUrl)
      .transition(.opacity)
  }

  /// The timeline's frames: the blurred cover at the drift's pose for each. Made outside the main actor, as SwiftUI may
  /// draw them off the main thread while it animates; it only places what it's given. (One type of frame every time,
  /// so the type erasure costs nothing: each frame updates the last.)
  nonisolated static func drifting<Content: View>(_ content: Content, since start: Date, still: Bool) -> (TimelineViewDefaultContext) -> AnyView {
    { context in AnyView(posed(content, still ? DriftPose() : DriftPose.at(context.date.timeIntervalSince(start)))) }
  }

  /// `content` at `pose`: moved by its fraction of the size, turned and grown.
  nonisolated static func posed<Content: View>(_ content: Content, _ pose: DriftPose) -> some View {
    content.visualEffect { effect, geometry in
      effect
        .offset(x: pose.x * geometry.size.width, y: pose.y * geometry.size.height)
        .rotationEffect(.degrees(pose.degrees))
        .scaleEffect(pose.scale)
    }
  }
}

/// Where the backdrop has drifted to (index.css's `drift`): moved by a fraction of its size, turned and grown, within
/// what the blown-up cover covers, so its blurred edge never comes into a corner.
struct DriftPose: Equatable, Sendable {
  var x = 0.0
  var y = 0.0
  var degrees = 0.0
  var scale = 1.0

  /// Seconds each way: out through the poses, then back.
  static let seconds = 40.0

  /// The keyframes, as fractions of the way (the web's 0 %, 35 %, 70 %, 100 %).
  static let keyframes: [(at: Double, pose: DriftPose)] = [
    (0, DriftPose()),
    (0.35, DriftPose(x: -0.05, y: 0.04, degrees: 8, scale: 1.1)),
    (0.7, DriftPose(x: 0.04, y: -0.03, degrees: -6, scale: 1.06)),
    (1, DriftPose(x: -0.03, y: -0.04, degrees: 12, scale: 1.14)),
  ]

  /// The pose `elapsed` seconds in: 40 s out, 40 s back, each stretch between two poses eased in and out (CSS's
  /// `ease-in-out`, which `animation-timing-function` applies to each keyframe's stretch).
  static func at(_ elapsed: Double) -> DriftPose {
    let lap = elapsed.truncatingRemainder(dividingBy: 2 * seconds)
    let way = max(0, lap < seconds ? lap / seconds : 2 - lap / seconds)
    guard let next = keyframes.firstIndex(where: { $0.at >= way }), next > 0 else { return keyframes[0].pose }
    let (from, to) = (keyframes[next - 1], keyframes[next])
    let t = easeInOut((way - from.at) / (to.at - from.at))
    func mix(_ a: Double, _ b: Double) -> Double { a + (b - a) * t }
    return DriftPose(
      x: mix(from.pose.x, to.pose.x), y: mix(from.pose.y, to.pose.y), degrees: mix(from.pose.degrees, to.pose.degrees),
      scale: mix(from.pose.scale, to.pose.scale))
  }

  /// CSS's `ease-in-out`, cubic-bezier(0.42, 0, 0.58, 1), at `x` of the way.
  static func easeInOut(_ x: Double) -> Double {
    x <= 0 ? 0 : x >= 1 ? 1 : UnitCurve.easeInOut.value(at: x)
  }
}
