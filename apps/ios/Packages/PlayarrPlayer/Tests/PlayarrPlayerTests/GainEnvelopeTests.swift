import Foundation
import Testing
@testable import PlayarrPlayer

struct GainEnvelopeTests {
  @Test func theFadeCurveIsEqualPower() {
    #expect(fadeCurve(0) == 0)
    #expect(fadeCurve(1) == 1)
    #expect(abs(fadeCurve(0.5) - 0.5.squareRoot()) < 1e-12)
    for x in stride(from: 0.0, through: 1.0, by: 0.05) {
      let power = fadeCurve(x) * fadeCurve(x) + fadeCurve(1 - x) * fadeCurve(1 - x)
      #expect(abs(power - 1) < 1e-12)
    }
  }

  @Test func aCrossfadeKeepsThePowerSteadyAtEverySample() {
    let ramp = Ramp(start: 1000, frames: 441)
    let outgoing = GainEnvelope(fadeOut: ramp)
    let incoming = GainEnvelope(fadeIn: ramp)
    #expect(outgoing.value(at: 999) == 1)
    #expect(incoming.value(at: 999) == 0)
    for t in ramp.start..<ramp.end {
      let a = Double(outgoing.value(at: t)), b = Double(incoming.value(at: t))
      #expect(abs(a * a + b * b - 1) < 1e-5)
    }
    #expect(outgoing.value(at: ramp.end) == 0)
    #expect(incoming.value(at: ramp.end) == 1)
  }

  @Test func gainsGoUpAsWellAsDown() {
    #expect(abs(GainEnvelope(gainDb: 6).gain - 1.9953) < 1e-3)
    #expect(abs(GainEnvelope(gainDb: -6).gain - 0.5012) < 1e-3)
    var block = PCMBlock(left: [0.25, 0.25], right: [0.1, 0.1])
    GainEnvelope(gainDb: 6).apply(to: &block, at: 0)
    #expect(abs(block.left[0] - 0.4988) < 1e-3)
    #expect(abs(block.right[1] - 0.1995) < 1e-3)
  }

  @Test func aFadeIsAppliedSampleBySampleWhereABlockMeetsIt() {
    var block = PCMBlock(left: [Float](repeating: 1, count: 10), right: [Float](repeating: 1, count: 10))
    let envelope = GainEnvelope(gainDb: 0, fadeOut: Ramp(start: 105, frames: 4))
    envelope.apply(to: &block, at: 100)
    #expect(Array(block.left.prefix(5)) == [1, 1, 1, 1, 1])
    #expect(block.left[5] == 1)
    #expect(abs(block.left[6] - Float(fadeCurve(0.75))) < 1e-6)
    #expect(Array(block.left.suffix(1)) == [0])
  }

  @Test func aZeroLengthFadeOutIsACut() {
    let cut = GainEnvelope(fadeOut: Ramp(start: 50, frames: 0))
    #expect(cut.value(at: 49) == 1)
    #expect(cut.value(at: 50) == 0)
  }
}
