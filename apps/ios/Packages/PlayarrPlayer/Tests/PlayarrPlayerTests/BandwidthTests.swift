import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

struct BandwidthTests {
  @Test func knowsNothingUntilSomethingIsMeasured() {
    #expect(Bandwidth().estimate() == nil)
    let remembered = Bandwidth(kbps: 900)
    #expect(remembered.estimate() == 900)
    // What it started from isn't remembered again as if measured.
    #expect(remembered.measured == nil)
    remembered.record(bytes: 125_000, seconds: 0.5)
    #expect(remembered.measured != nil)
  }

  @Test func countsASlowdownWithinSecondsAndABurstOnlyOnceItLasts() throws {
    let meter = Bandwidth()
    // 10 seconds at 2 Mbps.
    for _ in 0..<20 { meter.record(bytes: 125_000, seconds: 0.5) }
    #expect(abs(try #require(meter.estimate()) - 2000) < 1)
    // Half a second at 20 Mbps hardly counts: the slow average holds it.
    meter.record(bytes: 1_250_000, seconds: 0.5)
    #expect(try #require(meter.estimate()) < 3500)
    // Ten seconds at 200 kbps: the quick average brings it down.
    for _ in 0..<20 { meter.record(bytes: 12_500, seconds: 0.5) }
    #expect(try #require(meter.estimate()) < 600)
  }

  @Test func aSongThatFellBehindHoldsTheEstimateBelowItsBitrateForAWhile() throws {
    let meter = Bandwidth(kbps: 5000)
    let now = Date()
    meter.fellBehind(at: 900, now: now)
    #expect(meter.estimate(now: now) == 675)
    // Faster again: still held below the bitrate that fell behind, for 3 minutes.
    for _ in 0..<40 { meter.record(bytes: 500_000, seconds: 0.5) }
    #expect(meter.estimate(now: now.addingTimeInterval(170)) == 675)
    #expect(try #require(meter.estimate(now: now.addingTimeInterval(181))) > 6000)
  }

  @Test func fallingBehindAgainSoonHoldsTwiceAsLong() throws {
    let meter = Bandwidth(kbps: 5000)
    let now = Date()
    meter.fellBehind(at: 900, now: now)
    meter.fellBehind(at: 900, now: now.addingTimeInterval(240))
    for _ in 0..<40 { meter.record(bytes: 500_000, seconds: 0.5) }
    #expect(meter.estimate(now: now.addingTimeInterval(240 + 350)) == 675)
    #expect(try #require(meter.estimate(now: now.addingTimeInterval(240 + 361))) > 6000)
    // Long after: 3 minutes again.
    let later = now.addingTimeInterval(3600)
    meter.fellBehind(at: 900, now: later)
    for _ in 0..<40 { meter.record(bytes: 500_000, seconds: 0.5) }
    #expect(try #require(meter.estimate(now: later.addingTimeInterval(181))) > 6000)
  }

  @Test func aNewNetworkStartsFromWhatWasLastMeasuredOnItsKindOrFromNothing() {
    let meter = Bandwidth(kbps: 5000)
    meter.fellBehind(at: 900)
    meter.reset(to: 30_000)
    #expect(meter.estimate() == 30_000)
    meter.reset()
    #expect(meter.estimate() == nil)
  }
}

struct AutoQualityTests {
  let flac = encodable(song(1))  // 900 kbps
  let hiRes = encodable(song(2), kbps: 4600)
  let mp3 = encodable(song(3, container: "mp3"), kbps: 192)

  @Test func picksTheBestQualityTheConnectionKeepsUpWith() {
    #expect(AutoQuality.pick(for: flac, kbps: 50_000) == .original)
    #expect(AutoQuality.pick(for: flac, kbps: 1200) == .original)
    #expect(AutoQuality.pick(for: flac, kbps: 1100) == .high)
    #expect(AutoQuality.pick(for: flac, kbps: 300) == .normal)
    #expect(AutoQuality.pick(for: flac, kbps: 120) == .low)
    #expect(AutoQuality.pick(for: flac, kbps: 20) == .low)
    // Each song by its own file: a hi-res one needs more than a CD's.
    #expect(AutoQuality.pick(for: hiRes, kbps: 3000) == .high)
    #expect(AutoQuality.pick(for: hiRes, kbps: 6000) == .original)
  }

  @Test func startsAtNormalAndNeverGoesPastItInLowDataMode() {
    #expect(AutoQuality.pick(for: flac, kbps: nil) == .normal)
    #expect(AutoQuality.pick(for: flac, kbps: 50_000, lowDataMode: true) == .normal)
    #expect(AutoQuality.pick(for: flac, kbps: 120, lowDataMode: true) == .low)
  }

  @Test func goesDownAQualityThatMakesTheSongSmaller() {
    #expect(AutoQuality.below(.original, for: flac) == .high)
    #expect(AutoQuality.below(.high, for: flac) == .normal)
    #expect(AutoQuality.below(.normal, for: flac) == .low)
    #expect(AutoQuality.below(.low, for: flac) == nil)
    // An MP3 at 192 kbps plays as it is at High: below its own file comes Normal.
    #expect(AutoQuality.below(.original, for: mp3) == .normal)
    #expect(AutoQuality.below(.high, for: mp3) == .normal)
  }

  @Test func aSongThatFellBehindAtAQualityIsPickedBelowItNext() throws {
    for quality in [StreamQuality.original, .high, .normal] {
      let meter = Bandwidth(kbps: 50_000)
      meter.fellBehind(at: quality.bitrate(of: flac))
      let next = AutoQuality.pick(for: flac, kbps: meter.estimate())
      #expect(next == AutoQuality.below(quality, for: flac), "after \(quality)")
    }
  }
}
