import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

struct EnergyPictureTests {
  /// 120 BPM from 0.5 s: phrases of 8 s at 0.5, 8.5, 16.5…
  let map = MixMapEntry(
    version: 8, duration: 40, bpm: 120, firstBeat: 0.5, downbeatOffset: 0, gridStable: true, beatConfidence: 0.9, introEnd: 8.5,
    outroStart: 32.5, coldStart: false, coldEnd: false, soundStart: 0.5, soundEnd: 39.5, phraseEnergy: [0.2, nil, 1, 0.5, 0.1])

  @Test func drawsAPhraseAsLoudAsItSounds() {
    #expect(EnergyPicture.heardHeight(1) == 1)
    #expect(abs(EnergyPicture.heardHeight(pow(10, -10.0 / 20)) - 0.5) < 0.01)  // 10 dB down: half as tall
  }

  @Test func placesPhrasesAndBarsOnThePicturesClock() {
    let (phrases, bars) = EnergyPicture.phrasesAndBars(map, clock: { $0 }, from: 0, to: 40)
    #expect(phrases.map(\.at) == [0.5, 16.5, 24.5, 32.5])  // the unmeasured phrase is left out
    #expect(abs(phrases[0].left - 0.5 / 40) < 1e-12)
    #expect(bars.count == 20)
    #expect(bars.filter(\.phrase).count == 5)
  }

  @Test func theNextSongRunsAtItsAverageRateThroughTheMix() {
    let plan = TransitionPlan(
      style: .long, aStart: 100, bStart: 10, length: 20, bResume: 30.4, switchAt: 10, bRate: [.init(at: 0, value: 1.02)],
      aGain: [.init(at: 0, value: 1), .init(at: 10, value: 1), .init(at: 16, value: 0)], bGain: [.init(at: 0, value: 0)],
      aLowDb: [.init(at: 0, value: 0)], bLowDb: [.init(at: 0, value: 0)], aHighPassHz: [.init(at: 0, value: 20)], reason: "", beats: 32)
    let clock = EnergyPicture.nextSongClock(plan)
    #expect(clock(5) == -5)
    #expect(abs(clock(30.4) - 20) < 1e-9)
    #expect(abs(clock(31.4) - 21) < 1e-9)
    #expect(EnergyPicture.overlap(plan, bpmA: 120) == 16)
    var long = map
    long.duration = 400
    let strips = EnergyPicture.aroundTheMix(plan, a: ("Into the Trees", long), b: ("Hung Up", long))
    #expect(strips.map(\.note) == ["mixes out from 1:40", "comes in from 0:10"])
    #expect(abs(strips[0].mixLeft - 24.0 / 68) < 1e-9)
    #expect(abs(strips[0].mixWidth - 16.0 / 68) < 1e-9)
  }
}
