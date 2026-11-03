import Foundation

/// One channel of a DJ move's filter, following an automation curve, for a mix the engine plays itself: the low shelf
/// of the bass swap or the high-pass of the quick-mix sweep. As packages/mix/src/render/filters.ts: the Audio EQ
/// Cookbook's responses in Andrew Simper's trapezoidal state-variable form (whose state stays meaningful when the
/// coefficients change), redesigned every 128 samples from the curve, cross-faded with the dry signal over 512
/// samples when it turns on or off. It runs on blocks as they're scheduled, keeping its state between them.
final class MixFilter {
  enum Kind { case lowShelf, highPass }

  static let block: Int64 = 128
  static let shelfHz = 250.0
  static let highPassOffHz = 20.0
  static let fade = 512
  private static let fadeCurve: [Double] = (0...fade).map { 0.5 - 0.5 * cos(Double.pi * Double($0) / Double(fade)) }
  private static let denormal = 1e-20

  private let kind: Kind
  private var a1 = 0.0, a2 = 0.0, a3 = 0.0, m0 = 1.0, m1 = 0.0, m2 = 0.0
  private var ic1 = 0.0, ic2 = 0.0
  private var wet = 0
  private var active = false
  private var designedFor: Int64 = -1

  init(_ kind: Kind) { self.kind = kind }

  /// Filters `samples` in place; `firstIndex` is the first sample's position counted from the curve's time 0, and
  /// `value(seconds)` the curve. Before time 0 nothing is touched.
  func process(_ samples: inout [Float], firstIndex: Int64, value: (Double) -> Double) {
    for i in samples.indices {
      let n = firstIndex + Int64(i)
      guard n >= 0 else { continue }
      let gridBlock = n / Self.block
      if gridBlock != designedFor {
        designedFor = gridBlock
        design(value(Double(gridBlock * Self.block) / EngineFormat.sampleRate))
      }
      let v0 = Double(samples[i])
      let v3 = v0 - ic2
      let v1 = a1 * ic1 + a2 * v3
      let v2 = ic2 + a2 * ic1 + a3 * v3
      ic1 = 2 * v1 - ic1
      ic2 = 2 * v2 - ic2
      if abs(ic1) < Self.denormal { ic1 = 0 }
      if abs(ic2) < Self.denormal { ic2 = 0 }
      wet = min(Self.fade, max(0, wet + (active ? 1 : -1)))
      guard wet > 0 else { continue }
      let y = m0 * v0 + m1 * v1 + m2 * v2
      samples[i] = Float(v0 + Self.fadeCurve[wet] * (y - v0))
    }
  }

  /// Neutral (a flat shelf, a high-pass at 20 Hz or less) leaves the sound dry; the last active setting is kept while
  /// fading out.
  private func design(_ value: Double) {
    let rate = EngineFormat.sampleRate
    switch kind {
    case .lowShelf:
      active = abs(value) >= 0.01
      guard active || wet == 0 else { return }
      let a = pow(10, value / 40)
      let k = 2.0.squareRoot()
      setIntegrators(g: tan(Double.pi * Self.shelfHz / rate) / a.squareRoot(), k: k)
      (m0, m1, m2) = (1, k * (a - 1), a * a - 1)
    case .highPass:
      active = value > Self.highPassOffHz
      guard active || wet == 0 else { return }
      let k = 2.0.squareRoot()
      setIntegrators(g: tan(Double.pi * min(value, 0.45 * rate) / rate), k: k)
      (m0, m1, m2) = (1, -k, -1)
    }
  }

  private func setIntegrators(g: Double, k: Double) {
    a1 = 1 / (1 + g * (g + k))
    a2 = g * a1
    a3 = g * a2
  }
}
