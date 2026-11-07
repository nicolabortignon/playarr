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

  @Test func underTheSeekBarTheSongsPhrasesSpanTheWholeSong() {
    // Placed over the player's duration (a second longer than the map's here), else the map's.
    let phrases = EnergyPicture.songPhrases(map, duration: 41)
    #expect(phrases.map(\.at) == [0.5, 16.5, 24.5, 32.5])
    #expect(abs(phrases[1].left - 16.5 / 41) < 1e-12)
    #expect(abs(phrases[1].width - 8.0 / 41) < 1e-12)
    #expect(abs(EnergyPicture.songPhrases(map, duration: 0)[1].left - 16.5 / 40) < 1e-12)
    // Nothing to draw for a song not analyzed or without a beat: the strip keeps its room, empty.
    var beatless = map
    beatless.bpm = 0
    #expect(EnergyPicture.songPhrases(nil, duration: 40).isEmpty)
    #expect(EnergyPicture.songPhrases(beatless, duration: 40).isEmpty)
  }

  @Test func scrubbingTicksWhereTheIntroEndsTheDropLandsAndTheOutroStarts() {
    var song = map
    song.firstDrop = 16.5
    #expect(EnergyPicture.sectionBoundaries(song, duration: 40) == [8.5, 16.5, 32.5])
    #expect(EnergyPicture.section(0, boundaries: [8.5, 16.5, 32.5]) == 0)
    #expect(EnergyPicture.section(8.5, boundaries: [8.5, 16.5, 32.5]) == 1)
    #expect(EnergyPicture.section(20, boundaries: [8.5, 16.5, 32.5]) == 2)
    #expect(EnergyPicture.section(39, boundaries: [8.5, 16.5, 32.5]) == 3)
    // A drop where the intro ends ticks once; no intro (a cold start) or no outro isn't a boundary.
    song.firstDrop = 8.8
    #expect(EnergyPicture.sectionBoundaries(song, duration: 40) == [8.5, 32.5])
    song.introEnd = 0
    song.firstDrop = nil
    song.outroStart = 40
    #expect(EnergyPicture.sectionBoundaries(song, duration: 40).isEmpty)
    #expect(EnergyPicture.sectionBoundaries(nil, duration: 40).isEmpty)
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
