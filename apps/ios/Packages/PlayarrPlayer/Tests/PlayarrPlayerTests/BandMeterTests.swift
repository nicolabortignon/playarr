import Foundation
import Testing
@testable import PlayarrPlayer

/// The engine's meter (plan 7 §2): what the web's `levelsOf` reads off its analyzer (ported from pulse.test.ts on the
/// analyzer's scale, 0–1 for its bytes), then real tones through the phone's own analysis.
struct BandMeterTests {
  /// `seconds` of a sine at `hz`, its peak at `amplitude`, at 44.1 kHz.
  static func tone(_ hz: Double, amplitude: Float = 0.5, seconds: Double = 1) -> [Float] {
    (0..<Int(seconds * 44_100)).map { amplitude * Float(sin(2 * Double.pi * hz * Double($0) / 44_100)) }
  }

  /// The last reading of `samples`, heard from host time 10 s.
  static func lastReading(_ samples: [Float], meter: inout BandMeter) -> BandLevels? {
    samples.withUnsafeBufferPointer { meter.hear($0, start: 10) }.last?.levels
  }

  // MARK: Against how loud it has lately been (`levelsOf`)

  @Test func readsTheBassTheMiddleAndTheTrebleApart() {
    var peaks = [0.0, 0.0, 0.0]
    let full = (0..<3).map { BandMeter.follow(200.0 / 255, peak: &peaks[$0], elapsed: 0) }
    #expect(full == [1, 1, 1])
    // The bass drops out (a breakdown): its bar falls, the others don't.
    let bass = BandMeter.follow(120.0 / 255, peak: &peaks[0], elapsed: 1)
    let middle = BandMeter.follow(200.0 / 255, peak: &peaks[1], elapsed: 1)
    #expect(bass < 0.6)
    #expect(middle > 0.9)
  }

  @Test func readsAgainstHowLoudTheMusicHasLatelyBeenSoAQuietBridgeReadsQuiet() {
    var peak = 0.0
    #expect(BandMeter.follow(230.0 / 255, peak: &peak, elapsed: 0) == 1)
    // A second after a loud drop, a passage about 16 dB quieter reads low…
    #expect(BandMeter.follow(170.0 / 255, peak: &peak, elapsed: 1) < 0.5)
    // …and rises as the peak falls back, 1.4 dB a second.
    let later = BandMeter.follow(170.0 / 255, peak: &peak, elapsed: 5)
    #expect(abs(later - (170.0 / 255 - (230.0 / 255 - 0.02 * 6 - 0.35)) / 0.35) < 1e-9)
    // A quiet song all along moves its bars as much as a loud one.
    var quiet = 0.0
    #expect(BandMeter.follow(140.0 / 255, peak: &quiet, elapsed: 0) > 0.8)
  }

  @Test func readsSilenceAsSilenceNeverAsTheLoudestYet() {
    var peak = 0.0
    #expect(BandMeter.follow(0, peak: &peak, elapsed: 0) == 0)
    // Under −68.5 dB the peak counts as −68.5 dB: near silence stays down.
    #expect(BandMeter.follow(0.1, peak: &peak, elapsed: 0) == 0)
  }

  // MARK: What's heard

  @Test func hearsALowNoteInTheBassAlone() throws {
    var meter = try #require(BandMeter(sampleRate: 44_100))
    let levels = try #require(Self.lastReading(Self.tone(100), meter: &meter))
    #expect(levels.bass > 0.99)
    #expect(levels.middle == 0)
    #expect(levels.treble == 0)
  }

  @Test func hearsHiHatsInTheTrebleAloneButNotOneHighNote() throws {
    // Hi-hats fill the treble's whole width, here as tones every 150 Hz from 2.5 to 9.5 kHz: the band reads full.
    let hats = (0..<44_100).map { n -> Float in
      stride(from: 2_500.0, through: 9_500, by: 150).reduce(Float(0)) { sum, hz in
        sum + 0.015 * Float(sin(2 * Double.pi * hz * Double(n) / 44_100 + hz * hz * 0.37))
      }
    }
    var meter = try #require(BandMeter(sampleRate: 44_100))
    let levels = try #require(Self.lastReading(hats, meter: &meter))
    #expect(levels.treble > 0.99)
    #expect(levels.bass == 0)
    #expect(levels.middle == 0)
    // One high note is a few of the treble's 188 bins: as the web's analyzer reads it, next to nothing.
    var other = try #require(BandMeter(sampleRate: 44_100))
    #expect(try #require(Self.lastReading(Self.tone(5_000), meter: &other)).treble == 0)
  }

  @Test func hearsSilenceAsNothing() throws {
    var meter = try #require(BandMeter(sampleRate: 48_000))
    let levels = try #require(Self.lastReading([Float](repeating: 0, count: 48_000), meter: &meter))
    #expect(levels == BandLevels(all: 0))
  }

  @Test func theVolumeSetDoesntMatter() throws {
    // The same note 20 dB down, heard on its own: as tall.
    var meter = try #require(BandMeter(sampleRate: 44_100))
    let levels = try #require(Self.lastReading(Self.tone(100, amplitude: 0.05), meter: &meter))
    #expect(levels.bass > 0.99)
  }

  @Test func aNoteStoppingFallsToNothingWithinHalfASecond() throws {
    var meter = try #require(BandMeter(sampleRate: 44_100))
    _ = Self.lastReading(Self.tone(100), meter: &meter)
    let after = try #require(Self.lastReading([Float](repeating: 0, count: 22_050), meter: &meter))
    #expect(after.bass == 0)
  }

  @Test func readsSixtyTimesASecondOfMusicEachAtItsLastSample() throws {
    var meter = try #require(BandMeter(sampleRate: 44_100))
    let readings = [Float](repeating: 0, count: 4_410).withUnsafeBufferPointer { meter.hear($0, start: 10) }
    let sixtieths: [Double] = (1...6).map { (k: Int) -> Double in 10 + Double(k * 735) / 44_100 }
    #expect(readings.map(\.at) == sixtieths)
    // A buffer that ends between two readings carries its rest over to the next.
    let next = [Float](repeating: 0, count: 400).withUnsafeBufferPointer { meter.hear($0, start: 10.1) }
    #expect(next.isEmpty)
    let then = [Float](repeating: 0, count: 400).withUnsafeBufferPointer { meter.hear($0, start: 10.1 + 400.0 / 44_100) }
    #expect(then.count == 1)
    #expect(abs((then.first?.at ?? 0) - (10.1 + 735.0 / 44_100)) < 1e-9)
  }
}
