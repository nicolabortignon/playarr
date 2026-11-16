import Foundation
import Synchronization

/// How fast songs arrive from the server (kbps), measured from the stream cache's downloads as their bytes come in, for
/// Automatic streaming quality (`AutoQuality`). Two running averages of what's measured, a quick one and a slow one,
/// and the lower of the two: a slowdown counts at once, a burst only once it lasts, as players that adapt to the
/// network do. An encoded stream comes no faster than the server encodes it, so on a fast connection what's measured
/// is less than the connection could carry: the estimate errs low, never high.
///
/// A song that couldn't keep up at a bitrate (`fellBehind`) holds the estimate below that bitrate for a while, so the
/// next songs don't try it again straight away: 3 minutes, twice as long each time it happens again within 10 minutes
/// of the last, up to 30.
public final class Bandwidth: Sendable {
  /// Half-lives of the two averages, in seconds of measuring.
  static let quick = 3.0
  static let slow = 10.0
  /// What a song that fell behind holds the estimate to: this much of its bitrate.
  static let fallBack = 0.75
  static let holdFor: TimeInterval = 3 * 60
  static let holdAtMost: TimeInterval = 30 * 60
  /// Falling behind again within this long of the last time holds twice as long.
  static let again: TimeInterval = 10 * 60

  private struct State {
    var quick: Double?
    var slow: Double?
    var hold: (kbps: Double, until: Date)?
    var held: TimeInterval = 0
    var lastFellBehind: Date?
    /// Something was measured (or fell behind) since it started: not only what it started from.
    var measuredHere = false
  }

  private let state = Mutex(State())

  public init(kbps: Double? = nil) {
    if let kbps { reset(to: kbps) }
  }

  /// `bytes` came in over `seconds` of one download.
  public func record(bytes: Int, seconds: Double) {
    guard bytes > 0, seconds > 0 else { return }
    let kbps = Double(bytes) * 8 / seconds / 1000
    state.withLock { s in
      s.measuredHere = true
      s.quick = Self.average(s.quick, kbps, seconds: seconds, halfLife: Self.quick)
      s.slow = Self.average(s.slow, kbps, seconds: seconds, halfLife: Self.slow)
    }
  }

  /// The connection's speed as measured (kbps), held below the bitrate of a song that fell behind; nil before anything
  /// was measured.
  public func estimate(now: Date = Date()) -> Double? {
    state.withLock { s in
      guard let quick = s.quick, let slow = s.slow else { return nil }
      let measured = min(quick, slow)
      guard let hold = s.hold, hold.until > now else { return measured }
      return min(measured, hold.kbps)
    }
  }

  /// The speed measured since it started, without a hold: what's remembered for the next time on this network. Nil
  /// when nothing was: what it started from isn't remembered again.
  public var measured: Double? {
    state.withLock { s in s.measuredHere ? s.quick.flatMap { q in s.slow.map { min(q, $0) } } : nil }
  }

  /// A song at `kbps` couldn't keep up: the music ran dry, or its stream gave up. The estimate goes below it, and
  /// stays there for a while.
  public func fellBehind(at kbps: Double, now: Date = Date()) {
    state.withLock { s in
      let soonAgain = s.lastFellBehind.map { now.timeIntervalSince($0) < Self.again } ?? false
      s.held = soonAgain ? min(s.held * 2, Self.holdAtMost) : Self.holdFor
      s.lastFellBehind = now
      s.measuredHere = true
      let below = kbps * Self.fallBack
      s.hold = (min(below, s.hold.map { $0.until > now ? $0.kbps : .infinity } ?? .infinity), now.addingTimeInterval(s.held))
      // What was measured before it fell behind was too hopeful: from here on, at most what it holds to.
      s.quick = min(s.quick ?? below, below)
      s.slow = min(s.slow ?? below, below)
    }
  }

  /// Starts again from `kbps` (what was last measured on this network), or from nothing: a new network.
  public func reset(to kbps: Double? = nil) {
    state.withLock { s in
      s = State()
      s.quick = kbps
      s.slow = kbps
    }
  }

  private static func average(_ old: Double?, _ new: Double, seconds: Double, halfLife: Double) -> Double {
    guard let old else { return new }
    let weight = 1 - pow(2, -seconds / halfLife)
    return old + (new - old) * weight
  }
}
