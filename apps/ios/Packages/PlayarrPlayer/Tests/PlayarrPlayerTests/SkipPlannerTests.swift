import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// A press of Next with DJ mix on mixes on the next bar: the arithmetic on A's beat grid.
struct SkipPlannerTests {
  /// 120 BPM (half a second a beat, 2 s a bar), the first downbeat at 0.5 s: bars at 0.5, 2.5, 4.5…
  func song(bpm: Double = 120, firstBeat: Double = 0.5, downbeatOffset: Double = 0, barsSure: Double? = nil, beat: Double = 0.9) -> MixMapEntry {
    MixMapEntry(
      version: 8, duration: 240, bpm: bpm, firstBeat: firstBeat, downbeatOffset: downbeatOffset, downbeatConfidence: barsSure,
      gridStable: true, beatConfidence: beat, introEnd: 32.5, outroStart: 200.5, coldStart: false, coldEnd: false, soundStart: 0,
      soundEnd: 239, phraseEnergy: [])
  }

  @Test func landsOnTheNextBarLineWithAFourBeatLeadIn() {
    // The mix may start from 61.6 s: 4 beats (2 s) on is 63.6, and the next bar line from there is 64.5.
    let plan = SkipPlanner.plan(a: song(), b: song(bpm: 121), mode: .auto, at: 61.6)
    #expect(plan.style == .quick)
    #expect(plan.beats == 4)
    #expect(abs(plan.aStart - 62.5) < 1e-9)
    #expect(abs(plan.aStart + plan.beats * 0.5 - 64.5) < 1e-9)
    // From 60.4, 4 beats on is 62.4: bar 62.5. Two beats would land there too, so the lead-in stays 4 beats.
    #expect(SkipPlanner.plan(a: song(), b: song(bpm: 121), mode: .auto, at: 60.4).beats == 4)
  }

  @Test func takesATwoBeatLeadInWhenThatLandsABarSooner() {
    // From 61.3, 4 beats on is 63.3 (bar 64.5), but 2 beats on is 62.3: bar 62.5, a bar sooner.
    let plan = SkipPlanner.plan(a: song(), b: song(bpm: 121), mode: .auto, at: 61.3)
    #expect(plan.beats == 2)
    #expect(abs(plan.aStart - 61.5) < 1e-9)
  }

  @Test func landsOnABeatWhenTheBarsAreUnsure() {
    let plan = SkipPlanner.plan(a: song(barsSure: 0.2), b: song(bpm: 121), mode: .auto, at: 61.3)
    // Beats every 0.5 s from 0.5: 4 beats from 61.3 is 63.3, the next beat 63.5.
    #expect(abs(plan.aStart + plan.beats * 0.5 - 63.5) < 1e-9)
  }

  @Test func stretchesBOnlyWithinTwoPercentAndElseCuts() {
    let near = SkipPlanner.plan(a: song(), b: song(bpm: 121), mode: .auto, at: 61.3)
    #expect(near.bRate.contains { abs($0.value - 120.0 / 121.0) < 1e-9 })
    #expect(near.bRate.last?.value == 1)
    let far = SkipPlanner.plan(a: song(), b: song(bpm: 128), mode: .auto, at: 61.3)
    #expect(far.bRate == [AutomationItem(at: 0, value: 1)])
    #expect(far.bGain.contains { $0.at == far.switchAt && $0.value == 0 })
  }

  @Test func withoutASureBeatItCrossfadesForTwoAndAHalfSecondsAndNoMixingGoesStraightOn() {
    let fade = SkipPlanner.plan(a: song(beat: 0.3), b: song(), mode: .auto, at: 61.3)
    #expect(fade.style == .fade)
    #expect(fade.length == 2.5)
    #expect(fade.aStart == 61.3)
    let off = SkipPlanner.plan(a: song(), b: song(), mode: .off, at: 61.3)
    #expect(off.style == .straight)
    #expect(off.aStart == 61.3)
    #expect(off.bStart == 0)
  }
}
