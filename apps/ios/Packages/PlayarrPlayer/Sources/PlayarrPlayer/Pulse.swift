import AVFoundation
import Foundation
import PlayarrAPI
import Synchronization

// Keeping time with the music (plan 7 §2): what the now-playing bars, Now Playing's glow and a DJ blend's covers follow,
// as apps/web/src/player/pulse.ts and blend.ts, rule for rule. Every analyzed song has a beat grid (its mix map); the
// engine says where the song is, to the sample, and its meter (`BandMeter`) how loud each part of what's heard is.

/// How loud the bass, the middle and the treble of what's heard are, 0–1 (each against how loud it has lately been);
/// also the three bars' heights, which stand for them.
public struct BandLevels: Sendable, Equatable {
  public var bass: Double
  public var middle: Double
  public var treble: Double

  public init(bass: Double, middle: Double, treble: Double) {
    self.bass = bass
    self.middle = middle
    self.treble = treble
  }

  public init(all value: Double) { self.init(bass: value, middle: value, treble: value) }
}

/// A song's beat, where its grid can be trusted. Times in seconds of the song.
public struct SongBeat: Sendable, Equatable {
  /// Seconds per beat.
  public var beat: Double
  /// The music's first downbeat: bars start there and every four beats, before it and after.
  public var firstBar: Double
  /// Energy per 16-beat phrase from the first bar, 0–1 (nil: not measured).
  public var phraseEnergy: [Double?]

  public init(beat: Double, firstBar: Double, phraseEnergy: [Double?] = []) {
    self.beat = beat
    self.firstBar = firstBar
    self.phraseEnergy = phraseEnergy
  }

  /// The song's beat from its mix map, when the grid holds over the whole song: a tempo that wanders (a live drummer),
  /// or a beat too unsure to go by (noise, beatless music, where `gridStable` is false too), would drift off it. Nil
  /// then, and for a song not analyzed: the bars keep their loop, and there's no glow.
  public init?(_ map: MixMapEntry?) {
    guard let map, map.bpm > 0, map.gridStable else { return nil }
    let beat = 60 / map.bpm
    self.init(beat: beat, firstBar: map.firstBeat + map.downbeatOffset * beat, phraseEnergy: map.phraseEnergy)
  }

  /// Where `time` falls between marks `period` apart from `origin`: 0 on a mark, nearly 1 just before the next.
  public static func phase(of time: Double, origin: Double, period: Double) -> Double {
    let x = (time - origin) / period
    return x - x.rounded(.down)
  }

  /// A beat lands this fast: two frames, so it reads as on the beat rather than rising to it.
  static let land = 0.03

  /// A beat landing, 0–1: up within `land`, then falling away until the next (to e^-fall of it).
  public static func hit(_ phase: Double, period: Double, fall: Double = 3) -> Double {
    let land = min(0.3, Self.land / period)
    return phase < land ? phase / land : exp(-fall * (phase - land) / (1 - land))
  }

  /// The lowest a bar goes, of its full height: the music at rest, silence, or paused.
  public static let barRest = 0.22
  /// Between beats a bar keeps this much of its level: a loud passage stays tall, and the beat lifts it the rest.
  static let barHold = 0.4

  /// The three bars at rest.
  public static let rest = BandLevels(all: barRest)

  /// The three bars at `time`, of their full height: the bass, the middle and the treble, each as loud as its part of
  /// the music is (`levels`), lifted as each beat lands and falling away until the next; the middle falls slower, and
  /// the treble lands on every half beat, as hi-hats do.
  public func barHeights(at time: Double, levels: BandLevels) -> BandLevels {
    let half = beat / 2
    let onBeat = Self.phase(of: time, origin: firstBar, period: beat)
    func height(_ level: Double, _ lift: Double) -> Double {
      Self.barRest + (1 - Self.barRest) * min(1, max(0, level)) * (Self.barHold + (1 - Self.barHold) * lift)
    }
    return BandLevels(
      bass: height(levels.bass, Self.hit(onBeat, period: beat, fall: 3.2)),
      middle: height(levels.middle, Self.hit(onBeat, period: beat, fall: 1.6)),
      treble: height(levels.treble, Self.hit(Self.phase(of: time, origin: firstBar, period: half), period: half, fall: 3)))
  }

  /// Now Playing's glow breathes in over the last part of each bar…
  static let inhaleFrom = 0.82
  /// …and out from its downbeat, to e^-exhale by the end of the bar.
  static let exhale = 4.0

  /// Where Now Playing's glow is in its breath at `time`, 0–1: fullest on each bar's downbeat, breathing out across the
  /// bar and in again before the next. Smooth both ways, so it swells rather than flashes.
  public func breath(at time: Double) -> Double {
    let p = Self.phase(of: time, origin: firstBar, period: 4 * beat)
    let x = (p - Self.inhaleFrom) / (1 - Self.inhaleFrom)
    return max(exp(-Self.exhale * p), x > 0 ? x * x * (3 - 2 * x) : 0)
  }

  /// How much is going on in the phrase at `time`, from the mix map, 0–1 (1 where it wasn't measured).
  public func energy(at time: Double) -> Double {
    let k = max(0, Int(((time - firstBar) / (16 * beat)).rounded(.down)))
    guard phraseEnergy.indices.contains(k), let energy = phraseEnergy[k] else { return 1 }
    return min(1, max(0, energy))
  }
}

/// A DJ blend being heard (apps/web/src/player/blend.ts): both songs sounding together, from the start of the
/// transition until the song being left has faded out of it, whatever happens meanwhile (the switch to the next song,
/// a pause). The player's cover shows both, and Now Playing says "Mixing into Teardrop".
public struct Blend: Sendable, Equatable {
  public var from: Track
  public var to: Track
  public var plan: TransitionPlan
  /// Where the transition starts on the engine's clock, in seconds (`Pulse.Frame.engineTime`).
  public var start: Double
  /// The engine's item mixed into: the same mix while it's the same.
  var into: UUID

  /// Only a blend or a quick mix plays both songs at once: a fade or straight on isn't one to show.
  public static func isBlend(_ plan: TransitionPlan) -> Bool { plan.style == .long || plan.style == .quick }

  /// How long both songs sound together, from the start of the transition: until the song playing has faded out (its
  /// gain's last step down to silence), else the plan's beats at its tempo. The rest of the plan is the next song
  /// easing back to its own tempo, alone.
  public static func overlap(_ plan: TransitionPlan, bpmA: Double) -> Double {
    if plan.aGain.contains(where: { $0.value > 0 }) { return plan.aGain.silentFrom(limit: plan.length) }
    return bpmA > 0 && plan.beats > 0 ? min(plan.beats * 60 / bpmA, plan.length) : plan.length
  }

  /// How much of each song is in what's heard `time` seconds into the transition, 0–1: each one's gain in the plan, so
  /// their covers cross-fade as the songs do.
  public static func shares(_ plan: TransitionPlan, at time: Double) -> (from: Double, to: Double) {
    func share(_ gain: Automation) -> Double { gain.isEmpty ? 1 : min(1, max(0, gain.value(at: time))) }
    return (share(plan.aGain), share(plan.bGain))
  }
}

/// The music's clock as it's heard, and what the meter hears, read at any moment from any thread: SwiftUI may draw the
/// bars' and the glow's frames off the main thread while it animates (iOS 26). The Player sets the clock on its tick;
/// the engine's meter adds its readings as it makes them, sixty for each second of music.
public final class Pulse: Sendable {
  /// One moment of the music, for whatever keeps time with it.
  public struct Frame: Sendable, Equatable {
    /// Where the song playing is, in seconds, as it's heard.
    public var time: Double
    /// Seconds on the engine's clock, as heard: a blend's covers follow the transition by it.
    public var engineTime: Double
    /// What's heard now; nil while nothing is (paused, loading) or nothing listens.
    public var levels: BandLevels?
    /// The music plays: the clock moves.
    public var playing: Bool
    /// Seconds since it started playing (the glow comes in over the first moments).
    public var playingFor: Double
  }

  /// One reading of the meter: what was heard in the sixtieth of a second up to `at`, a host time in seconds.
  public struct Reading: Sendable, Equatable {
    public var at: Double
    public var levels: BandLevels

    public init(at: Double, levels: BandLevels) {
      self.at = at
      self.levels = levels
    }
  }

  /// A reading this old isn't what's heard any more (the music paused, the meter off): none.
  static let stale = 0.25
  /// Readings are kept this long: over AirPlay the music is heard a couple of seconds after it's played.
  static let kept = 4.0

  private struct State {
    var songTime = 0.0
    var engineTime = 0.0
    /// The host time both were read at.
    var at = 0.0
    var playing = false
    var playingSince = 0.0
    var latency = 0.0
    var readings: [Reading] = []
    var madeUp: BandLevels?
  }

  private let state = Mutex(State())

  public init() {}

  /// Now, on the clock the engine and the meter stamp their times with (the host's, in seconds).
  public static func hostNow() -> Double { AVAudioTime.seconds(forHostTime: mach_absolute_time()) }

  /// The music at host time `host`: where the song is as it's heard (`latency` after it's played), moving on from the
  /// last tick while it plays, and the last reading of what was heard by then.
  public func frame(at host: Double = Pulse.hostNow()) -> Frame {
    state.withLock { s in
      let moved = s.playing ? max(0, host - s.at) - s.latency : 0
      var levels: BandLevels?
      if s.playing {
        let heard = host - s.latency
        if let madeUp = s.madeUp {
          levels = madeUp
        } else if let last = s.readings.last(where: { $0.at <= heard }), heard - last.at <= Self.stale {
          levels = last.levels
        }
      }
      return Frame(
        time: s.songTime + moved, engineTime: s.engineTime + moved, levels: levels, playing: s.playing,
        playingFor: s.playing ? max(0, host - s.playingSince) : 0)
    }
  }

  /// The Player's tick: the song's time and the engine's at host time `at` (when the engine last rendered), whether it
  /// plays, and how long after it's played the music is heard (`AVAudioSession.outputLatency`).
  public func setClock(songTime: Double, engineTime: Double, at: Double, playing: Bool, latency: Double) {
    state.withLock { s in
      if playing && !s.playing { s.playingSince = at }
      s.songTime = songTime
      s.engineTime = engineTime
      s.at = at
      s.playing = playing
      s.latency = max(0, latency)
    }
  }

  /// What the meter heard, in the order it heard it.
  public func hear(_ readings: [Reading]) {
    state.withLock { s in
      s.readings.append(contentsOf: readings)
      guard let last = s.readings.last?.at, let keep = s.readings.firstIndex(where: { $0.at >= last - Self.kept }), keep > 0 else { return }
      s.readings.removeFirst(keep)
    }
  }

  /// Levels to show in place of the meter's while the music plays (the demo plays silence, and its screen tour would
  /// show the bars at rest); nil goes back to the meter.
  public func makeUp(_ levels: BandLevels?) {
    state.withLock { $0.madeUp = levels }
  }
}
