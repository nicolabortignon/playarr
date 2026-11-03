import PlayarrAPI

/// The lines Edit mix points' markers snap to: every bar from the music's first downbeat, or every second when no
/// beat was found; `big` steps make a phrase (4 bars) or 10 seconds (MixPointsDialog.tsx gridOf, snap, stepFrom).
public struct MixGrid: Equatable, Sendable {
  public let origin: Double
  public let step: Double
  public let big: Int

  /// Without a beat, the outer buttons move this many seconds.
  public static let secondsWithoutBeat = 10
  /// Float slack when deciding whether a time sits on a line.
  static let epsilon = 1e-6

  public init(origin: Double, step: Double, big: Int) {
    self.origin = origin
    self.step = step
    self.big = big
  }

  public init(map: MixMapEntry) {
    if map.bpm > 0 {
      let beat = 60 / map.bpm
      self.init(origin: map.firstBeat + map.downbeatOffset * beat, step: 4 * beat, big: 4)
    } else {
      self.init(origin: 0, step: 1, big: Self.secondsWithoutBeat)
    }
  }

  /// Milliseconds are plenty, and keep 0.5 + 9 × 2 from becoming 18.499999.
  public static func tidy(_ t: Double) -> Double { Format.jsRound(t * 1000) / 1000 }

  /// The web's clamp: `lo` wins over nothing, `hi` over everything.
  static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { min(max(v, lo), hi) }

  /// Line `index`, or the nearest line within [min, max]; `fallback` (clamped) when no line is.
  public func line(_ index: Int, min lower: Double, max upper: Double, fallback: Double) -> Double {
    let lo = Int((((lower - origin) / step) - Self.epsilon).rounded(.up))
    let hi = Int((((upper - origin) / step) + Self.epsilon).rounded(.down))
    guard lo <= hi else { return Self.clamp(fallback, lower, upper) }
    return Self.tidy(origin + Double(Swift.min(Swift.max(index, lo), hi)) * step)
  }

  /// The line nearest `t`, within [min, max] (a drag).
  public func snap(_ t: Double, min lower: Double, max upper: Double) -> Double {
    line(Int(Format.jsRound((t - origin) / step)), min: lower, max: upper, fallback: t)
  }

  /// `n` lines on from `t` (back for a negative `n`); from between two lines, the first step lands on the next one.
  public func step(from t: Double, by n: Int, min lower: Double, max upper: Double) -> Double {
    let at = (t - origin) / step
    let from = n > 0 ? Int((at + Self.epsilon).rounded(.down)) : Int((at - Self.epsilon).rounded(.up))
    return line(from + n, min: lower, max: upper, fallback: t)
  }
}
