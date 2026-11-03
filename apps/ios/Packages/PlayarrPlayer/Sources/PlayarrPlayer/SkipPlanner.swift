import Foundation
import PlayarrAPI

/// The plan for a press of Next mixed live (`skipPlan` in packages/mix/src/plan.ts, with the parts of the planner it
/// uses): leave A as soon as possible from `at`, mid-song if need be. Both beats sure → a quick mix landing on a bar line
/// of A with a 4-beat lead-in (2 when that lands a bar sooner), so the cut comes under 6 beats after `at`; otherwise a
/// 2.5 s crossfade, or straight on into an abrupt start. "No mixing" still means straight on. The server never plans
/// skips, so the app plans them itself; `mix-fixtures.mjs` checks this port against the TypeScript.
public enum SkipPlanner {
  static let quickMixConfidence = 0.5
  static let sameTempoDrift = 0.002
  static let quickMixStretchGap = 0.02
  static let longestBlendBeats = 64.0
  static let quickCrossfadeBeats = 2.0
  static let cutTailBeats = 1.0
  static let cutSeconds = 0.02
  static let skipFade = 2.5
  static let skipLeadBeats = [4.0, 2.0]
  static let shortestFade = 1.0
  static let ownTempoHold = 0.1
  static let ownTempoRamp = 0.2
  static let curvePoints = 8
  static let phraseBeats = 16.0
  static let barBeats = 4.0
  static let highPassOffHz = 20.0
  static let highPassSweepHz = 800.0
  static let epsilon = 1e-9

  /// `sameAlbumInOrder`: B follows A on its album; a skip mixes them anyway, but straight on then keeps B's start.
  public static func plan(a: MixMapEntry, b: MixMapEntry, mode: MixMode, sameAlbumInOrder: Bool = false, at requested: Double) -> TransitionPlan {
    let pair = Pair(a: a, b: b, mode: mode, sameAlbumInOrder: sameAlbumInOrder)
    guard requested.isFinite else { return straight(pair, "Skipped, but with no time to leave at: straight on") }
    let at = min(max(0, requested), duration(a))
    func leaving(_ plan: TransitionPlan) -> TransitionPlan {
      var plan = plan
      if plan.style == .straight { plan.aStart = at }
      return plan
    }
    if mode == .off { return leaving(straight(pair, "Skipped, no mixing: straight on")) }
    let sureBeat = { (song: MixMapEntry) in usableTempo(song) && song.beatConfidence >= quickMixConfidence }
    guard sureBeat(a), sureBeat(b) else {
      if b.coldStart { return leaving(straight(pair, "Skipped, no sure beat and an abrupt start: straight on")) }
      var plan = fade(pair, "Skipped, no sure beat: crossfade", from: at, longest: skipFade)
      if plan.style == .straight { plan.reason = "Skipped; \(plan.reason)" }
      return leaving(plan)
    }
    var plan = quick(pair, "Skipped: quick mix", at: at)
    if plan.style == .straight { plan.reason = "Skipped; \(plan.reason)" }
    return leaving(plan)
  }

  // MARK: The pair

  struct Pair {
    let a: MixMapEntry
    let b: MixMapEntry
    let mode: MixMode
    let sameAlbumInOrder: Bool
    let ratio: Double
    let tempoGap: Double
    let aBarsSure: Bool
    let bBarsSure: Bool

    init(a: MixMapEntry, b: MixMapEntry, mode: MixMode, sameAlbumInOrder: Bool) {
      self.a = a
      self.b = b
      self.mode = mode
      self.sameAlbumInOrder = sameAlbumInOrder
      let tempos = usableTempo(a) && usableTempo(b)
      let matched = tempos ? tempoRatio(a.bpm, b.bpm) : 1
      ratio = abs(matched - 1) * longestBlendBeats * (tempos ? beatLength(a) : 0) < sameTempoDrift ? 1 : matched
      tempoGap = abs(ratio - 1)
      aBarsSure = (a.downbeatConfidence ?? 1) >= MixSequence.minDownbeatConfidence
      bBarsSure = (b.downbeatConfidence ?? 1) >= MixSequence.minDownbeatConfidence
    }
  }

  /// B's rate that matches A: a.bpm / b.bpm, doubled or halved when that's closer to 1.
  static func tempoRatio(_ aBpm: Double, _ bBpm: Double) -> Double {
    let plain = aBpm / bBpm
    return [plain, plain * 2, plain / 2].reduce(plain) { abs($1 - 1) < abs($0 - 1) ? $1 : $0 }
  }

  // MARK: The plans

  static func quick(_ pair: Pair, _ reason: String, at: Double) -> TransitionPlan {
    let a = pair.a, b = pair.b
    guard usableTempo(a), usableTempo(b) else { return straight(pair, "No usable beat: straight on") }
    let stretched = pair.tempoGap <= quickMixStretchGap + epsilon
    let tailBeats = stretched ? 0 : cutTailBeats
    guard let placement = skipPlacement(pair, tailBeats: tailBeats, at: at) else {
      return straight(pair, "Too close to the end to mix: straight on")
    }
    let beat = beatLength(a)
    let landingAt = placement.beats * beat
    let rate = stretched ? pair.ratio : 1
    let leadInB = landingAt * rate
    let tailInB = tailBeats * beat * rate
    let holdOvershoot = max(0, (ownTempoRamp / 2 + ownTempoHold) * (1 - rate))
    let latestLanding = resumeLimit(b) - tailInB - holdOvershoot
    let target = mixInPoint(b)
    let bar = pair.bBarsSure ? barBeats : 1
    let phraseLanding = nearestLine(b, pair.bBarsSure ? phraseBeats : 1, target, notBefore: leadInB)
    var landing = abs(phraseLanding - target) <= (phraseBeats / 2) * beatLength(b) ? phraseLanding : nearestLine(b, bar, target, notBefore: leadInB)
    if landing > latestLanding + epsilon {
      guard let earlier = lastLineAtOrBefore(b, bar, latestLanding), earlier >= leadInB - epsilon else {
        return straight(pair, "B’s outro comes too soon to mix: straight on")
      }
      landing = earlier
    }
    guard landing < soundEnd(b) else { return straight(pair, "B is too short to mix into: straight on") }
    let bStart = max(0, landing - leadInB)
    let length = landingAt + tailBeats * beat
    let bRate = steadyRate(rate, length)
    var plan = TransitionPlan(
      style: .quick, aStart: placement.aStart, bStart: bStart, length: length,
      bResume: bStart + bRate.integral(from: 0, to: length), switchAt: landingAt, bRate: bRate,
      aGain: [], bGain: [], aLowDb: flatDb, bLowDb: flatDb, aHighPassHz: highPassSweep(0, landingAt), reason: reason,
      beats: placement.beats)
    if stretched {
      let crossfade = landingAt - quickCrossfadeBeats * beat
      plan.switchAt = crossfade
      plan.aGain = [AutomationItem(at: 0, value: 1)] + equalPower(crossfade, landingAt, fadingIn: false)
      plan.bGain = [AutomationItem(at: 0, value: 0)] + equalPower(crossfade, landingAt, fadingIn: true)
    } else {
      plan.aGain = [AutomationItem(at: 0, value: 1)] + equalPower(landingAt, length, fadingIn: false)
      plan.bGain = [
        AutomationItem(at: 0, value: 0), AutomationItem(at: landingAt, value: 0), AutomationItem(at: landingAt + cutSeconds, value: 1),
      ]
    }
    return plan
  }

  /// The landing is a bar line of A (a beat with unsure bars) with the whole lead-in at or after `at`.
  static func skipPlacement(_ pair: Pair, tailBeats: Double, at: Double) -> (aStart: Double, beats: Double)? {
    let a = pair.a
    let beat = beatLength(a)
    let line = pair.aBarsSure ? barBeats : 1
    var best: (aStart: Double, beats: Double, landing: Double)?
    for beats in skipLeadBeats {
      let landing = firstLineAtOrAfter(a, line, at + beats * beat)
      let sooner = best == nil || (pair.aBarsSure && landing < (best?.landing ?? 0) - epsilon)
      if sooner { best = (landing - beats * beat, beats, landing) }
    }
    guard let best, best.landing <= soundEnd(a) - tailBeats * beat + epsilon else { return nil }
    return (best.aStart, best.beats)
  }

  static func fade(_ pair: Pair, _ reason: String, from: Double, longest: Double) -> TransitionPlan {
    let a = pair.a, b = pair.b
    let end = soundEnd(a)
    let roomInA = end - from
    let bStart = soundStart(b)
    let roomInB = resumeLimit(b) - bStart
    guard roomInA >= shortestFade else { return straight(pair, "Too close to the end to fade: straight on") }
    guard roomInB >= shortestFade else { return straight(pair, "B’s outro comes too soon to mix: straight on") }
    let length = min(longest, roomInA, roomInB)
    return TransitionPlan(
      style: .fade, aStart: from, bStart: bStart, length: length, bResume: bStart + length, switchAt: length / 2,
      bRate: [AutomationItem(at: 0, value: 1)], aGain: equalPower(0, length, fadingIn: false), bGain: equalPower(0, length, fadingIn: true),
      aLowDb: flatDb, bLowDb: flatDb, aHighPassHz: highPassOff, reason: reason, beats: 0)
  }

  static func straight(_ pair: Pair, _ reason: String) -> TransitionPlan {
    let asRecorded = pair.mode == .off || pair.sameAlbumInOrder
    let bStart = asRecorded ? 0 : soundStart(pair.b)
    return TransitionPlan(
      style: .straight, aStart: asRecorded ? duration(pair.a) : soundEnd(pair.a), bStart: bStart, length: 0, bResume: bStart,
      switchAt: 0, bRate: [AutomationItem(at: 0, value: 1)], aGain: [AutomationItem(at: 0, value: 0)],
      bGain: [AutomationItem(at: 0, value: 1)], aLowDb: flatDb, bLowDb: flatDb, aHighPassHz: highPassOff, reason: reason, beats: 0)
  }

  // MARK: Curves

  static let flatDb = [AutomationItem(at: 0, value: 0)]
  static let highPassOff = [AutomationItem(at: 0, value: highPassOffHz)]

  static func steadyRate(_ rate: Double, _ length: Double) -> Automation {
    if abs(rate - 1) < epsilon { return [AutomationItem(at: 0, value: rate)] }
    let backToOwn = max(0, length - ownTempoHold)
    return [
      AutomationItem(at: 0, value: rate), AutomationItem(at: max(0, backToOwn - ownTempoRamp), value: rate),
      AutomationItem(at: backToOwn, value: 1),
    ]
  }

  static func equalPower(_ from: Double, _ to: Double, fadingIn: Bool) -> Automation {
    sampleCurve(from, to) { fadingIn ? sin($0 * .pi / 2) : cos($0 * .pi / 2) }
  }

  static func highPassSweep(_ from: Double, _ to: Double) -> Automation {
    sampleCurve(from, to) { highPassOffHz * pow(highPassSweepHz / highPassOffHz, $0) }
  }

  static func sampleCurve(_ from: Double, _ to: Double, _ shape: (Double) -> Double) -> Automation {
    (0..<curvePoints).map { i in
      let progress = Double(i) / Double(curvePoints - 1)
      let value = shape(progress)
      let snapped = abs(value - value.rounded()) < epsilon ? value.rounded() : value
      return AutomationItem(at: from + (to - from) * progress, value: snapped)
    }
  }

  // MARK: The grid and the songs

  static func beatLength(_ song: MixMapEntry) -> Double { 60 / song.bpm }
  static func usableTempo(_ song: MixMapEntry) -> Bool {
    song.bpm.isFinite && song.bpm > 0 && song.firstBeat.isFinite && song.downbeatOffset.isFinite
  }
  static func gridLine(_ song: MixMapEntry, _ beatsPerLine: Double, _ index: Double) -> Double {
    song.firstBeat + (song.downbeatOffset + index * beatsPerLine) * beatLength(song)
  }
  static func linesAt(_ song: MixMapEntry, _ beatsPerLine: Double, _ t: Double) -> Double {
    (t - gridLine(song, beatsPerLine, 0)) / (beatsPerLine * beatLength(song))
  }
  static func firstLineAtOrAfter(_ song: MixMapEntry, _ beatsPerLine: Double, _ t: Double) -> Double {
    gridLine(song, beatsPerLine, max(0, (linesAt(song, beatsPerLine, t) - epsilon).rounded(.up)))
  }
  static func lastLineAtOrBefore(_ song: MixMapEntry, _ beatsPerLine: Double, _ t: Double) -> Double? {
    let index = (linesAt(song, beatsPerLine, t) + epsilon).rounded(.down)
    return index < 0 ? nil : gridLine(song, beatsPerLine, index)
  }
  static func nearestLine(_ song: MixMapEntry, _ beatsPerLine: Double, _ target: Double, notBefore: Double) -> Double {
    let nearest = jsRound(linesAt(song, beatsPerLine, target))
    let earliest = (linesAt(song, beatsPerLine, notBefore) - epsilon).rounded(.up)
    return gridLine(song, beatsPerLine, max(nearest, earliest, 0))
  }
  /// JavaScript's Math.round: halves go up (Swift's `.rounded()` takes -2.5 to -3, Math.round to -2).
  static func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }

  static func finiteOr(_ value: Double, _ fallback: Double) -> Double { value.isFinite ? value : fallback }
  static func duration(_ song: MixMapEntry) -> Double { max(0, finiteOr(song.duration, 0)) }
  static func soundEnd(_ song: MixMapEntry) -> Double { min(max(finiteOr(song.soundEnd, duration(song)), 0), duration(song)) }
  static func soundStart(_ song: MixMapEntry) -> Double { min(max(finiteOr(song.soundStart ?? 0, 0), 0), soundEnd(song)) }
  static func mixInPoint(_ b: MixMapEntry) -> Double { finiteOr(b.cues?.mixIn ?? b.introEnd, 0) }
  static func resumeLimit(_ b: MixMapEntry) -> Double { finiteOr(b.cues?.mixOut ?? b.outroStart, soundEnd(b)) }
}
