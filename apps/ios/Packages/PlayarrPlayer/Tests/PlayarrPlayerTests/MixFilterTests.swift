import Foundation
import Testing
@testable import PlayarrPlayer

/// The bass swap's shelf and the quick mix's sweep, for mixes the engine plays itself.
struct MixFilterTests {
  func sine(_ hertz: Double, frames: Int) -> [Float] {
    (0..<frames).map { Float(0.5 * sin(2 * .pi * hertz * Double($0) / 44_100)) }
  }

  func rms(_ x: ArraySlice<Float>) -> Double { (x.reduce(0) { $0 + Double($1 * $1) } / Double(x.count)).squareRoot() }

  @Test func neutralLeavesTheSoundAsItIs() {
    var samples = sine(100, frames: 10_000)
    let dry = samples
    MixFilter(.highPass).process(&samples, firstIndex: 0) { _ in 20 }
    MixFilter(.lowShelf).process(&samples, firstIndex: 0) { _ in 0 }
    #expect(samples == dry)
  }

  @Test func theSweepTakesTheBassOutAndLeavesTheTop() {
    var bass = sine(50, frames: 44_100), top = sine(5000, frames: 44_100)
    MixFilter(.highPass).process(&bass, firstIndex: 0) { _ in 800 }
    MixFilter(.highPass).process(&top, firstIndex: 0) { _ in 800 }
    #expect(20 * log10(rms(bass[22_050...]) / rms(sine(50, frames: 44_100)[22_050...])) < -40)
    #expect(abs(20 * log10(rms(top[22_050...]) / rms(sine(5000, frames: 44_100)[22_050...]))) < 0.5)
  }

  @Test func theShelfCutsTheBassByWhatTheCurveSays() {
    var bass = sine(40, frames: 44_100), top = sine(5000, frames: 44_100)
    MixFilter(.lowShelf).process(&bass, firstIndex: 0) { _ in -24 }
    MixFilter(.lowShelf).process(&top, firstIndex: 0) { _ in -24 }
    let cut = 20 * log10(rms(bass[22_050...]) / rms(sine(40, frames: 44_100)[22_050...]))
    #expect(cut < -20 && cut > -25)
    #expect(abs(20 * log10(rms(top[22_050...]) / rms(sine(5000, frames: 44_100)[22_050...]))) < 0.5)
  }

  @Test func blocksOfAnySizeFilterAsOne() {
    let input = sine(80, frames: 30_000)
    var whole = input
    MixFilter(.highPass).process(&whole, firstIndex: 0) { 20 * pow(40, min(1, $0 / 0.5)) }
    let filter = MixFilter(.highPass)
    var pieces: [Float] = []
    var start = 0
    for size in [1000, 333, 22_050, 6617] {
      var piece = Array(input[start..<start + size])
      filter.process(&piece, firstIndex: Int64(start)) { 20 * pow(40, min(1, $0 / 0.5)) }
      pieces += piece
      start += size
    }
    #expect(pieces == whole)
  }
}
