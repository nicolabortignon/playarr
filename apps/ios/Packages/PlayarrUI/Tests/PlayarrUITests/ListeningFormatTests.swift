import Foundation
import SwiftUI
import Testing
@testable import PlayarrUI

@Suite struct ListeningFormatTests {
  let english = Locale(identifier: "en_US")

  @Test func saysMinutesHeard() {
    #expect(Format.minutes(45, locale: english) == "45 min")
    #expect(Format.minutes(95, locale: english) == "1 h 35 min")
    #expect(Format.minutes(120, locale: english) == "2 h")
    #expect(Format.minutes(61_000, locale: english) == "1,016 h 40 min")
    #expect(Format.number(5678, locale: english) == "5,678")
  }

  @Test func saysWhenAMixChanges() throws {
    let now = try #require(Format.parseDate("2026-11-03T10:00:00.000Z"))  // a Tuesday
    #expect(Format.changes(at: now.addingTimeInterval(40 * 60), now: now) == "Changes in 40 min")
    #expect(Format.changes(at: now.addingTimeInterval(10), now: now) == "Changes in 1 min")
    #expect(Format.changes(at: now.addingTimeInterval(9 * 3600), now: now) == "Changes in 9 h")
    let utc = TimeZone(identifier: "UTC")!
    #expect(Format.changes(at: now.addingTimeInterval(6 * 86400), now: now, locale: english, timeZone: utc) == "Changes on Monday")
  }

  private func close(_ rgb: RGB, _ r: Double, _ g: Double, _ b: Double) -> Bool {
    abs(rgb.r - r) < 0.002 && abs(rgb.g - g) < 0.002 && abs(rgb.b - b) < 0.002
  }

  /// CSS Color 4's own conversions of the sRGB primaries, white and a mid grey.
  @Test func turnsKnownOKLCHColoursIntoSRGB() {
    #expect(close(OKLCH.rgb(l: 0.627_955, c: 0.257_683, h: 29.233_885), 1, 0, 0))
    #expect(close(OKLCH.rgb(l: 0.866_440, c: 0.294_827, h: 142.495_339), 0, 1, 0))
    #expect(close(OKLCH.rgb(l: 0.452_014, c: 0.313_214, h: 264.052_021), 0, 0, 1))
    #expect(close(OKLCH.rgb(l: 1, c: 0, h: 0), 1, 1, 1))
    #expect(close(OKLCH.rgb(l: 0.598_708, c: 0, h: 0), 0.5, 0.5, 0.5))
    let wide = OKLCH.rgb(l: 0.62, c: 0.4, h: 150)
    for channel in [wide.r, wide.g, wide.b] { #expect((0...1).contains(channel)) }
  }

  @Test func placesCSSGradientAngles() {
    let down = CSSGradient.points(angle: 180)
    #expect(abs(down.start.x - 0.5) < 1e-9 && abs(down.start.y) < 1e-9 && abs(down.end.y - 1) < 1e-9)
    let right = CSSGradient.points(angle: 90)
    #expect(abs(right.start.x) < 1e-9 && abs(right.end.x - 1) < 1e-9 && abs(right.end.y - 0.5) < 1e-9)
    // The mix cover's 165deg: mostly down, a little to the right, corner to corner.
    let mix = CSSGradient.points(angle: 165)
    #expect(abs(mix.start.x - 0.341_5) < 0.001 && abs(mix.start.y - -0.091_5) < 0.001)
    #expect(abs(mix.end.x - 0.658_5) < 0.001 && abs(mix.end.y - 1.091_5) < 0.001)
  }
}
