import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// Keeping time with the music (plan 7 §2): ported from apps/web/src/player/pulse.test.ts and blend.test.ts, then the
/// phone's own clock and meter readings.
struct PulseTests {
  /// 120 BPM, its first downbeat at 1 s: beats every half second, bars every 2 s, phrases every 8 s.
  static func map(bpm: Double = 120, gridStable: Bool = true) -> MixMapEntry {
    MixMapEntry(
      version: mixMapVersion, duration: 200, bpm: bpm, firstBeat: 0.5, downbeatOffset: 1, gridStable: gridStable, beatConfidence: 0.9,
      introEnd: 16, outroStart: 180, coldStart: false, coldEnd: false, soundEnd: 199, phraseEnergy: [0.2, 1, nil])
  }

  let beat = SongBeat(Self.map())!
  let loud = BandLevels(all: 1)

  // MARK: A song's beat

  @Test func isItsMixMapsGridItsBarsFromTheFirstDownbeat() {
    #expect(beat.beat == 0.5)
    #expect(beat.firstBar == 1)
  }

  @Test func isNoneForASongNotAnalyzedWithoutATempoOrWhoseGridDoesntHold() {
    #expect(SongBeat(nil) == nil)
    #expect(SongBeat(Self.map(bpm: 0)) == nil)
    // A wandering tempo, or a beat too unsure to go by (gridStable is false below a confidence of 0.35).
    #expect(SongBeat(Self.map(gridStable: false)) == nil)
  }

  // MARK: The now-playing bars

  @Test func landOnEachBeatAndFallAwayUntilTheNext() {
    let on = beat.barHeights(at: 3.04, levels: loud)  // just after the beat at 3 s has landed
    let late = beat.barHeights(at: 3.45, levels: loud)  // just before the next
    #expect(on.bass > 0.95)
    #expect(late.bass < on.bass - 0.3)
    // The middle falls more slowly than the bass.
    #expect(late.middle > late.bass)
    // Up within a few hundredths of a second: on the beat, not rising to it.
    #expect(beat.barHeights(at: 3.0, levels: loud).bass < beat.barHeights(at: 3.03, levels: loud).bass)
    #expect(abs(beat.barHeights(at: 3.03, levels: loud).bass - 1) < 0.005)
  }

  @Test func landTheTrebleOnEveryHalfBeatAsHiHatsDo() {
    // Just after the half beat at 3.25 s has landed: the treble is up, the bass well down from its beat.
    #expect(beat.barHeights(at: 3.285, levels: loud).treble > 0.95)
    #expect(beat.barHeights(at: 3.285, levels: loud).bass < 0.75)
  }

  @Test func standAsTallAsEachPartOfTheMusicIsLoudAndAtRestInSilence() {
    let heights = beat.barHeights(at: 3.04, levels: BandLevels(bass: 1, middle: 0.5, treble: 0))
    #expect(heights.bass > heights.middle)
    #expect(heights.middle > heights.treble)
    #expect(heights.treble == SongBeat.barRest)
    #expect(beat.barHeights(at: 3.04, levels: BandLevels(all: 0)) == SongBeat.rest)
  }

  @Test func heightIsTheRestPlusTheLevelHeldBetweenBeatsAndLiftedOnThem() {
    // 0.22 + 0.78 × level × (0.4 + 0.6 × lift): on the beat's peak (lift 1) a half level is 0.22 + 0.39.
    #expect(abs(beat.barHeights(at: 3.03, levels: BandLevels(all: 0.5)).bass - (0.22 + 0.78 * 0.5)) < 0.005)
    // Just before the next beat the bass's lift is down to e^-3.2: what's held is 0.22 + 0.78 × 0.5 × (0.4 + 0.6 × e^-3.2).
    let held = 0.22 + 0.78 * 0.5 * (0.4 + 0.6 * exp(-3.2))
    #expect(abs(beat.barHeights(at: 3.4999, levels: BandLevels(all: 0.5)).bass - held) < 0.005)
  }

  // MARK: Now Playing's glow

  @Test func breathIsFullestOnEachBarsDownbeatOutAcrossTheBarAndInBeforeTheNext() {
    #expect(abs(beat.breath(at: 3) - 1) < 1e-6)  // the downbeat of the bar from 3 s
    #expect(beat.breath(at: 4) < 0.2)  // halfway
    #expect(beat.breath(at: 4.5) < 0.1)  // before breathing in
    #expect(beat.breath(at: 4.9) > 0.5)  // breathing in for the downbeat at 5 s
    #expect(abs(beat.breath(at: 5) - 1) < 1e-6)
  }

  @Test func neverFlashesFromOneFrameToTheNextItChangesOnlyALittle() {
    var biggest = 0.0
    for t in stride(from: 1.0, to: 9, by: 1.0 / 60) { biggest = max(biggest, abs(beat.breath(at: t + 1.0 / 60) - beat.breath(at: t))) }
    #expect(biggest < 0.15)
  }

  @Test func breathesDeeperInALoudPhraseThanAQuietOneAndAsDeepWhereAPhraseWasntMeasured() {
    #expect(beat.energy(at: 2) == 0.2)  // the first phrase, from 1 s
    #expect(beat.energy(at: 10) == 1)  // the second, from 9 s
    #expect(beat.energy(at: 20) == 1)  // not measured
    #expect(beat.energy(at: 0) == 0.2)  // before the first downbeat: as the first phrase
  }

  // MARK: A DJ blend you can see

  /// A 16 s blend: the next song comes in over the first 8 s, the first song goes over the last 8.
  let plan = TransitionFiles.plan(
    aStart: 100, length: 20, bResume: 30, switchAt: 8, aGain: [.init(at: 0, value: 1), .init(at: 8, value: 1), .init(at: 16, value: 0)],
    bGain: [.init(at: 0, value: 0), .init(at: 8, value: 1)])

  @Test func givesEachSongsCoverAsMuchOfThePictureAsItsSongHasOfTheMix() {
    #expect(Blend.shares(plan, at: 0) == (1, 0))
    #expect(Blend.shares(plan, at: 4) == (1, 0.5))
    #expect(Blend.shares(plan, at: 8) == (1, 1))
    #expect(Blend.shares(plan, at: 12) == (0.5, 1))
    #expect(Blend.shares(plan, at: 16) == (0, 1))
  }

  @Test func isABlendOrAQuickMixAFadeOrStraightOnPlaysOneSongAfterTheOther() {
    #expect(Blend.isBlend(TransitionFiles.plan(style: .long, aStart: 0, length: 4, bResume: 4, switchAt: 2)))
    #expect(Blend.isBlend(TransitionFiles.plan(style: .quick, aStart: 0, length: 4, bResume: 4, switchAt: 2)))
    #expect(!Blend.isBlend(TransitionFiles.plan(style: .fade, aStart: 0, length: 4, bResume: 4, switchAt: 2)))
    #expect(!Blend.isBlend(TransitionFiles.plan(style: .straight, aStart: 0, length: 4, bResume: 4, switchAt: 2)))
  }

  @Test func lastsUntilTheFirstSongHasFadedOutElseThePlansBeatsAtItsTempo() {
    #expect(Blend.overlap(plan, bpmA: 120) == 16)
    var silent = plan
    silent.aGain = [.init(at: 0, value: 0)]
    silent.beats = 16
    #expect(Blend.overlap(silent, bpmA: 120) == 8)
    #expect(Blend.overlap(silent, bpmA: 0) == 20)
  }

  // MARK: The clock as it's heard

  @Test func movesOnFromTheLastTickWhileItPlaysAsHeardAfterTheOutputsLatency() {
    let pulse = Pulse()
    pulse.setClock(songTime: 10, engineTime: 100, at: 50, playing: true, latency: 0.2)
    let frame = pulse.frame(at: 51)
    #expect(abs(frame.time - 10.8) < 1e-9)
    #expect(abs(frame.engineTime - 100.8) < 1e-9)
    #expect(frame.playing)
    #expect(frame.playingFor == 1)
    // The next tick moves the clock on; it started playing at the first.
    pulse.setClock(songTime: 10.1, engineTime: 100.1, at: 50.1, playing: true, latency: 0.2)
    #expect(pulse.frame(at: 52).playingFor == 2)
  }

  @Test func standsStillWhilePaused() {
    let pulse = Pulse()
    pulse.setClock(songTime: 10, engineTime: 100, at: 50, playing: false, latency: 0.2)
    pulse.hear([Pulse.Reading(at: 59.9, levels: BandLevels(all: 1))])
    let frame = pulse.frame(at: 60)
    #expect(frame.time == 10)
    #expect(!frame.playing)
    #expect(frame.playingFor == 0)
    #expect(frame.levels == nil)
  }

  @Test func givesTheLastReadingHeardByThenWhileItsFresh() {
    let pulse = Pulse()
    pulse.setClock(songTime: 10, engineTime: 100, at: 50, playing: true, latency: 0.2)
    let quiet = BandLevels(all: 0.3), loud = BandLevels(all: 0.9)
    pulse.hear([Pulse.Reading(at: 50.9, levels: quiet), Pulse.Reading(at: 51, levels: loud)])
    #expect(pulse.frame(at: 51.15).levels == quiet)  // heard at 50.95: played 0.2 s before
    #expect(pulse.frame(at: 51.2).levels == loud)
    #expect(pulse.frame(at: 51.05).levels == nil)  // nothing heard yet from what's been read
    #expect(pulse.frame(at: 51.5).levels == nil)  // 0.3 s on from the last reading: the meter stopped
  }

  @Test func keepsFourSecondsOfReadings() {
    let pulse = Pulse()
    pulse.setClock(songTime: 0, engineTime: 0, at: 50, playing: true, latency: 0)
    pulse.hear([Pulse.Reading(at: 50, levels: BandLevels(all: 0.5))])
    pulse.hear([Pulse.Reading(at: 55, levels: BandLevels(all: 1))])
    #expect(pulse.frame(at: 50.1).levels == nil)
  }

  @Test func showsMadeUpLevelsWhileItPlaysWhenAskedTo() {
    let pulse = Pulse()
    let madeUp = BandLevels(bass: 0.9, middle: 0.7, treble: 0.5)
    pulse.makeUp(madeUp)
    pulse.setClock(songTime: 0, engineTime: 0, at: 50, playing: true, latency: 0)
    #expect(pulse.frame(at: 50.5).levels == madeUp)
    pulse.setClock(songTime: 0.5, engineTime: 0.5, at: 50.5, playing: false, latency: 0)
    #expect(pulse.frame(at: 51).levels == nil)
  }
}
