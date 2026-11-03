import Foundation
import PlayarrAPI

/// Where A stops and B starts at a cut (song seconds): a cut on the beat, a silence cut, or the server's straight on.
public struct BeatCut: Sendable, Equatable, Codable {
  public var aEnd: Double
  public var bStart: Double
  public init(aEnd: Double, bStart: Double) {
    self.aEnd = aEnd
    self.bStart = bStart
  }
}

/// The parts of apps/web/src/player/mixSequence.ts the app needs, rule for rule: the transition's clock (the listener
/// only ever sees the two songs), the gain that keeps a transition at the songs' levels, and the cuts DJ mix makes
/// when there's no transition to play.
public enum MixSequence {
  /// Below this a beat grid is a guess (`STEADY_BEAT_CONFIDENCE` in plan.ts).
  public static let steadyBeatConfidence = 0.35
  /// Below this the bar starts are a guess (`MIN_DOWNBEAT_CONFIDENCE`).
  public static let minDownbeatConfidence = 0.4
  /// A cut never leaves A more than this before its real end.
  static let longestCut = 20.0
  /// B's intro longer than this many bars is mostly skipped at a cut.
  static let longIntroBars = 8.0
  /// Silence shorter than this at a join isn't worth a cut of its own.
  static let minSilence = 0.05

  // MARK: The transition's clock

  /// Where B is, in its own seconds, `t` into the transition: B plays at `bRate`.
  public static func bTimeAt(_ plan: TransitionPlan, _ t: Double) -> Double {
    plan.bStart + plan.bRate.integral(from: 0, to: t)
  }

  public enum Song: String, Sendable, Equatable, Codable { case a, b }

  /// The song to show `t` into the transition, and where in it: A until the switch, then B.
  public static func songTimeDuring(_ plan: TransitionPlan, _ t: Double) -> (song: Song, time: Double) {
    t < plan.switchAt ? (.a, plan.aStart + t) : (.b, bTimeAt(plan, t))
  }

  /// The point of the transition that shows B at `bTime`; nil outside the part that shows B.
  public static func transitionTimeFor(_ plan: TransitionPlan, _ bTime: Double) -> Double? {
    var low = plan.switchAt, high = plan.length
    guard bTime >= bTimeAt(plan, low), bTime < bTimeAt(plan, high) else { return nil }
    for _ in 0..<60 {
      let mid = (low + high) / 2
      if bTimeAt(plan, mid) <= bTime { low = mid } else { high = mid }
    }
    return low
  }

  /// How loud to play a transition file whose songs were made at other levels than they play at: `gainA` and `gainB`
  /// (linear) are what each song's own playback adds to what the file holds. Each counts as much as that song is heard:
  /// A's at the start, B's at the end, blended in decibels between (`bridgeGain`).
  public static func bridgeGain(_ plan: TransitionPlan, _ t: Double, gainA: Double, gainB: Double) -> Double {
    let a = pow(plan.aGain.value(at: t), 2), b = pow(plan.bGain.value(at: t), 2)
    let share = a + b > 0 ? b / (a + b) : (t < plan.switchAt ? 0 : 1)
    return pow(gainA, 1 - share) * pow(gainB, share)
  }

  // MARK: Cuts

  /// The cut from A into B on the beat (`beatCut`), or nil to play them the usual way: mixing off, songs of one album
  /// in order, no steady beat in either, or no downbeat late enough in A.
  public static func beatCut(_ a: MixMapEntry, _ b: MixMapEntry, aDuration: Double, mode: MixMode, sameAlbumInOrder: Bool) -> BeatCut? {
    guard mode != .off, !sameAlbumInOrder, steadyBeat(a), steadyBeat(b) else { return nil }
    let aOrigin = firstDownbeat(a), aLine = lineLength(a)
    let soundEnd = Swift.min(finiteOr(a.soundEnd, aDuration), aDuration)
    let aEnd = aOrigin + ((soundEnd - aOrigin) / aLine + 1e-9).rounded(.down) * aLine
    let earliest = Swift.max(aDuration - longestCut, finiteOr(a.cues?.mixOut ?? a.outroStart, 0))
    guard aEnd >= earliest, aEnd > 0 else { return nil }
    let bOrigin = Swift.max(0, firstDownbeat(b)), bLine = lineLength(b), bar = 4 * beatLength(b)
    let intoIntro = finiteOr(b.cues?.mixIn ?? b.introEnd, 0) - bar
    var bStart = bOrigin
    if intoIntro - bOrigin > longIntroBars * bar { bStart = bOrigin + ((intoIntro - bOrigin) / bLine - 1e-9).rounded(.up) * bLine }
    if bStart >= finiteOr(b.cues?.mixOut ?? b.outroStart, b.duration) { bStart = bOrigin }
    return bStart < b.duration ? BeatCut(aEnd: aEnd, bStart: bStart) : nil
  }

  /// DJ mix with no beat to cut on: the silence between the songs goes (`silenceCut`). Nil within an album played in
  /// order, with mixing off, or with no silence worth cutting.
  public static func silenceCut(_ a: MixMapEntry, _ b: MixMapEntry, aDuration: Double, mode: MixMode, sameAlbumInOrder: Bool) -> BeatCut? {
    guard mode != .off, !sameAlbumInOrder else { return nil }
    let aEnd = Swift.min(finiteOr(a.soundEnd, aDuration), aDuration)
    let bStart = Swift.max(0, Swift.min(finiteOr(b.soundStart ?? 0, 0), finiteOr(b.soundEnd, b.duration)))
    guard aEnd > 0, !(aDuration - aEnd < minSilence && bStart < minSilence) else { return nil }
    return BeatCut(aEnd: aEnd, bStart: bStart)
  }

  /// The server's "straight on" as a cut (`straightCut`); nil when that's A's end and B's start anyway.
  public static func straightCut(_ plan: TransitionPlan, aDuration: Double) -> BeatCut? {
    let aEnd = Swift.min(finiteOr(plan.aStart, aDuration), aDuration)
    let bStart = Swift.max(0, finiteOr(plan.bStart, 0))
    if aDuration - aEnd < minSilence && bStart < minSilence { return nil }
    return aEnd > 0 ? BeatCut(aEnd: aEnd, bStart: bStart) : nil
  }

  // MARK: The grid

  static func beatLength(_ song: MixMapEntry) -> Double { 60 / song.bpm }
  static func steadyBeat(_ song: MixMapEntry) -> Bool {
    song.bpm.isFinite && song.bpm > 0 && song.beatConfidence >= steadyBeatConfidence && song.firstBeat.isFinite && song.downbeatOffset.isFinite
  }
  static func firstDownbeat(_ song: MixMapEntry) -> Double { song.firstBeat + song.downbeatOffset * beatLength(song) }
  /// Bars, or beats where the bar starts are unsure (no confidence at all counts as sure).
  static func lineLength(_ song: MixMapEntry) -> Double {
    ((song.downbeatConfidence ?? 1) >= minDownbeatConfidence ? 4 : 1) * beatLength(song)
  }
  static func finiteOr(_ value: Double, _ fallback: Double) -> Double { value.isFinite ? value : fallback }
}
