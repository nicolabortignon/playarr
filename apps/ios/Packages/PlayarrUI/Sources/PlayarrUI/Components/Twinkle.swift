import SwiftUI

/// Feeling lucky's sparkles (apps/web/src/pages/Home.tsx `Twinkle`): three four-pointed stars, still at rest; while
/// the songs are picked each in turn swells, turns a little and shrinks away (the big one only dims), then comes back.
struct Twinkle: View {
  let on: Bool
  var size: CGFloat = 20
  @Environment(\.reducesMotion) private var reducesMotion

  /// Where each star sits in a 24-point square, how big, how far it shrinks, and when it twinkles.
  private static let stars: [(x: CGFloat, y: CGFloat, r: CGFloat, low: CGFloat, delay: Double)] = [
    (10, 13.5, 8.5, 0.45, 0), (19, 5, 4, 0, 0.35), (19.5, 19, 2.75, 0, 0.7),
  ]
  private static let period = 1.2

  var body: some View {
    TimelineView(.animation(paused: !on || reducesMotion)) { context in
      let time = context.date.timeIntervalSinceReferenceDate
      Canvas { canvas, area in
        let unit = area.width / 24
        for star in Self.stars {
          let (scale, angle, opacity) = on && !reducesMotion ? Self.pose(star.low, at: time - star.delay) : (1, 0, 1)
          var star4 = canvas
          star4.translateBy(x: star.x * unit, y: star.y * unit)
          star4.rotate(by: .degrees(angle))
          star4.scaleBy(x: star.r * unit * scale, y: star.r * unit * scale)
          star4.opacity = opacity
          star4.fill(FourPointStar().path(in: CGRect(x: -1, y: -1, width: 2, height: 2)), with: .foreground)
        }
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }

  /// A star's scale, turn (degrees) and opacity `time` seconds into its cycle: swell to 1.2, shrink to `low`
  /// while turning, come back.
  static func pose(_ low: CGFloat, at time: Double) -> (CGFloat, Double, Double) {
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
  func path(in rect: CGRect) -> Path {
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
