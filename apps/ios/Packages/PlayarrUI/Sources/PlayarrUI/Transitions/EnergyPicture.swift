import Foundation
import PlayarrAPI

/// Songs' energy per 16-beat phrase as columns over their bar lines: what the transition sheet draws around the mix
/// and Stats for nerds draws for the whole song. As apps/web/src/components/EnergyStrip.tsx and TransitionView.tsx.
public enum EnergyPicture {
  /// One phrase of a song, placed in a picture.
  public struct Phrase: Equatable, Sendable {
    /// Seconds into the song.
    public var at: Double
    public var energy: Double
    /// Start and end on the picture's clock.
    public var start: Double
    public var end: Double
    /// Position and width in the picture, 0–1.
    public var left: Double
    public var width: Double
    /// In the stretch where both songs sound together.
    public var inMix = false
  }

  /// A bar line in the picture, 0–1; `phrase` marks every fourth.
  public struct Bar: Equatable, Sendable {
    public var left: Double
    public var phrase: Bool
  }

  /// One song's strip around the mix.
  public struct Strip: Equatable, Sendable {
    public var title: String
    /// "mixes out from 3:20", "comes in from 0:16".
    public var note: String
    public var phrases: [Phrase]
    public var bars: [Bar]
    /// The mix, 0–1 (zero width for a straight cut).
    public var mixLeft: Double
    public var mixWidth: Double
  }

  /// How tall to draw a phrase of this energy: as loud as it sounds (level^0.6), so 10 dB down is half as tall.
  public static func heardHeight(_ energy: Double) -> Double { pow(max(0, energy), 0.6) }

  /// Seconds per beat and where the first bar starts, when the song has a beat.
  public static func beatGrid(_ map: MixMapEntry) -> (beat: Double, firstBar: Double)? {
    guard map.bpm > 0 else { return nil }
    let beat = 60 / map.bpm
    return (beat, map.firstBeat + map.downbeatOffset * beat)
  }

  /// A song's phrases and bars between `from` and `to` seconds of the picture's clock; `clock` turns song time into it.
  public static func phrasesAndBars(_ map: MixMapEntry, clock: (Double) -> Double, from: Double, to: Double) -> (phrases: [Phrase], bars: [Bar]) {
    let span = to - from
    let place = { (t: Double) in (min(max(t, from), to) - from) / span }
    guard let grid = beatGrid(map) else { return ([], []) }
    var phrases: [Phrase] = []
    for (k, energy) in map.phraseEnergy.enumerated() {
      guard let energy else { continue }  // not measured: left blank
      let at = grid.firstBar + Double(k) * 16 * grid.beat
      let start = clock(at), end = clock(min(at + 16 * grid.beat, map.duration))
      if end <= from || start >= to { continue }
      phrases.append(Phrase(at: at, energy: energy, start: start, end: end, left: place(start), width: place(end) - place(start)))
    }
    var bars: [Bar] = []
    var n = max(0, Int((-grid.firstBar / (4 * grid.beat)).rounded(.up)))
    while true {
      let at = grid.firstBar + Double(n) * 4 * grid.beat
      if at > map.duration { break }
      let t = clock(at)
      if t > to { break }
      if t >= from { bars.append(Bar(left: place(t), phrase: n % 4 == 0)) }
      n += 1
    }
    return (phrases, bars)
  }

  /// How long both songs sound together from the start of the mix: until A has faded out, else the plan's beats.
  public static func overlap(_ plan: TransitionPlan, bpmA: Double) -> Double {
    if plan.aGain.contains(where: { $0.value > 0 }) { return plan.aGain.silentFrom(limit: plan.length) }
    return bpmA > 0 && plan.beats > 0 ? min(plan.beats * 60 / bpmA, plan.length) : plan.length
  }

  /// Where the next song's moments fall on the picture's clock (0: the start of the mix): stretched to A's tempo
  /// during the mix, its seconds there run at the average rate.
  public static func nextSongClock(_ plan: TransitionPlan) -> (Double) -> Double {
    let span = plan.bResume - plan.bStart
    let rate = plan.length > 0 && span > 0 ? span / plan.length : 1
    return { t in
      t < plan.bStart ? t - plan.bStart : t <= plan.bStart + span ? (t - plan.bStart) / rate : plan.length + (t - plan.bStart - span)
    }
  }

  /// Seconds shown either side of the mix (more for a long mix).
  static let pad = 24.0

  /// Both songs' strips on one clock, the next song lined up where it comes in, so the shaded mix is the same stretch.
  public static func aroundTheMix(_ plan: TransitionPlan, a: (title: String, map: MixMapEntry), b: (title: String, map: MixMapEntry)) -> [Strip] {
    let pad = max(Self.pad, plan.length / 2)
    let from = -pad, to = plan.length + pad
    let mixLength = overlap(plan, bpmA: a.map.bpm)
    func strip(_ title: String, _ note: String, _ map: MixMapEntry, _ clock: (Double) -> Double) -> Strip {
      let span = to - from
      let place = { (t: Double) in (min(max(t, from), to) - from) / span }
      let mixEnd = clock(map.duration)
      var (phrases, bars) = phrasesAndBars(map, clock: clock, from: from, to: to)
      for i in phrases.indices {
        let p = phrases[i]
        phrases[i].inMix = mixLength > 0 ? p.start < mixLength && p.end > 0 : p.start <= 0 && p.end > 0
      }
      return Strip(title: title, note: note, phrases: phrases, bars: bars, mixLeft: place(0), mixWidth: place(min(mixLength, mixEnd)) - place(0))
    }
    return [
      strip(a.title, "mixes out from \(NerdFormat.time(plan.aStart))", a.map) { $0 - plan.aStart },
      strip(b.title, "comes in from \(NerdFormat.time(plan.bStart))", b.map, nextSongClock(plan)),
    ]
  }
}
