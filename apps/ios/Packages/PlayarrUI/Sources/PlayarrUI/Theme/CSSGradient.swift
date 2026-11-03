import SwiftUI

/// Where a CSS `linear-gradient(<angle>deg, …)` starts and ends on a box, as SwiftUI unit points. CSS angles turn
/// clockwise from "to top", and the gradient line runs through the centre, long enough for the corners to get the
/// first and last colours.
enum CSSGradient {
  static func points(angle degrees: Double, width: Double = 1, height: Double = 1) -> (start: UnitPoint, end: UnitPoint) {
    let radians = degrees * .pi / 180
    // The direction on screen (y grows downwards): 0deg is up, 90deg right, 180deg down.
    let (dx, dy) = (sin(radians), -cos(radians))
    let length = abs(width * dx) + abs(height * dy)
    let half = (x: dx * length / 2 / width, y: dy * length / 2 / height)
    return (UnitPoint(x: 0.5 - half.x, y: 0.5 - half.y), UnitPoint(x: 0.5 + half.x, y: 0.5 + half.y))
  }
}
