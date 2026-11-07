import SwiftUI

/// Feeling lucky's sparkles (apps/web/src/components/LuckyButton.tsx `Twinkle`): three four-pointed stars, still at
/// rest; while the songs are picked each in turn swells, turns a little and shrinks away (the big one only dims), then
/// comes back.
struct Twinkle: View {
  let on: Bool
  var size: CGFloat = 20
  @Environment(\.reducesMotion) private var reducesMotion

  /// Where each star sits in a 24-point square, how big, how far it shrinks, and when it twinkles.
  private nonisolated static let stars: [(x: CGFloat, y: CGFloat, r: CGFloat, low: CGFloat, delay: Double)] = [
    (10, 13.5, 8.5, 0.45, 0), (19, 5, 4, 0, 0.35), (19.5, 19, 2.75, 0, 0.7),
  ]
  private nonisolated static let period = 1.2

  var body: some View {
    Group {
      // Drawn by functions outside the main actor, not closures made here: SwiftUI can draw an animation's frames off
      // the main thread (iOS 26), and a closure made in `body` is the main actor's, which traps there (build 684).
      // Feeling lucky's fan of covers moves beside it as it twinkles.
      if on && !reducesMotion {
        TimelineView(.animation, content: Self.twinkling(_:))
      } else {
        Self.stars(at: nil)
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }

  /// The stars as they are at the timeline's moment.
  nonisolated static func twinkling(_ context: TimelineViewDefaultContext) -> some View {
    stars(at: context.date.timeIntervalSinceReferenceDate)
  }

  /// The three stars, `time` seconds into their twinkling, or still (nil).
  nonisolated static func stars(at time: Double?) -> some View {
    Canvas { canvas, area in
      let unit = area.width / 24
      for star in stars {
        let (scale, angle, opacity) = time.map { pose(star.low, at: $0 - star.delay) } ?? (1, 0, 1)
        var star4 = canvas
        star4.translateBy(x: star.x * unit, y: star.y * unit)
        star4.rotate(by: .degrees(angle))
        star4.scaleBy(x: star.r * unit * scale, y: star.r * unit * scale)
        star4.opacity = opacity
        star4.fill(FourPointStar().path(in: CGRect(x: -1, y: -1, width: 2, height: 2)), with: .foreground)
      }
    }
  }

  /// A star's scale, turn (degrees) and opacity `time` seconds into its cycle: swell to 1.2, shrink to `low`
  /// while turning, come back.
  nonisolated static func pose(_ low: CGFloat, at time: Double) -> (CGFloat, Double, Double) {
    let t = (time.truncatingRemainder(dividingBy: period) + period).truncatingRemainder(dividingBy: period) / period
    let ease = { (x: Double) in x * x * (3 - 2 * x) }
    let faded = low > 0 ? 0.7 : 0
    switch t {
    case ..<0.2:
      return (1 + 0.2 * ease(t / 0.2), 0, 1)
    case ..<0.6:
      let k = ease((t - 0.2) / 0.4)
      return (1.2 + (low - 1.2) * k, 45 * k, 1 + (faded - 1) * k)
    default:
      let k = ease((t - 0.6) / 0.4)
      return (low + (1 - low) * k, 45 + 45 * k, faded + (1 - faded) * k)
    }
  }
}

/// A four-pointed star with curved sides, filling its rectangle.
struct FourPointStar: Shape {
  nonisolated func path(in rect: CGRect) -> Path {
    let c = CGPoint(x: rect.midX, y: rect.midY)
    let rx = rect.width / 2
    let ry = rect.height / 2
    let k: CGFloat = 0.2
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: c.x + x * rx, y: c.y + y * ry) }
    var path = Path()
    path.move(to: p(0, -1))
    path.addCurve(to: p(1, 0), control1: p(k, -k), control2: p(k, -k))
    path.addCurve(to: p(0, 1), control1: p(k, k), control2: p(k, k))
    path.addCurve(to: p(-1, 0), control1: p(-k, k), control2: p(-k, k))
    path.addCurve(to: p(0, -1), control1: p(-k, -k), control2: p(-k, -k))
    path.closeSubpath()
    return path
  }
}
