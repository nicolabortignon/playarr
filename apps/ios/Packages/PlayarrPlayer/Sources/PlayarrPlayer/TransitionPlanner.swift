import Foundation
import Observation
import PlayarrAPI

/// Asks the server for the DJ transition from the song playing into the next while it plays, so it's rendered by the
/// time it's needed: `watchUpcomingTransition` in apps/web/src/player/transitions.ts, rule for rule.
///
/// - Only once the song has played 5 s (skipping through songs renders nothing), and 2 s after the pair settles.
/// - While the server renders: asked again every 3 s, after 5 polls (or while paused) every 10 s.
/// - A lost connection, 429 or a server error: again after 3 s, then every 10 s. Offline: when the network is back.
/// - "Unavailable" is asked once more after 60 s (the songs' analysis may have finished meanwhile).
/// - Not ready 20 s before the mix point: given up, and the songs follow each other the usual way.
/// - The position sent is the one at the first ask, unchanged after: the plan (and its render) depends on it. A seek
///   that leaves the answer behind (past a ready mix point, or too close to a pending one) asks afresh from there.
@MainActor @Observable
public final class TransitionPlanner {
  public static let minPlayed = 5.0
  public static let firstAskDelay = 2.0
  public static let pollInterval = 3.0
  public static let slowPollInterval = 10.0
  public static let fastPolls = 5
  public static let retryIntervals = [3.0, 10.0]
  public static let unavailableRetry = 60.0
  public static let giveUp = 20.0
  /// A ready transition survives a seek that lands at least this long before its mix point.
  public static let readyLead = 1.0
  /// After giving up, a jump back this far before the cut-off (a restart) is worth asking again.
  public static let restartMargin = 10.0
  /// The clock can step this little back or ahead without a seek: as a transition takes over from the song, the clock
  /// follows the transition, a few milliseconds off the song's own time. That's no jump leaving the answer behind.
  public static let settle = 0.5

  /// What's known of the transition into the next song: the server's answer, or "gave up".
  public enum Result: Sendable, Equatable {
    case answer(TransitionAnswer)
    case gaveUp

    public var plan: TransitionPlan? {
      switch self {
      case .answer(.ready(let r)): r.plan
      case .answer(.pending(let p)): p.plan
      case .answer(.straight(let s)): s.plan
      default: nil
      }
    }
  }

  /// The pair asked about (by file, as the decks know them) and what's known of it. Nil files: no transition wanted.
  public struct Upcoming: Sendable, Equatable {
    public var fromFileId: Int?
    public var toFileId: Int?
    public var result: Result?
    public init(fromFileId: Int? = nil, toFileId: Int? = nil, result: Result? = nil) {
      self.fromFileId = fromFileId
      self.toFileId = toFileId
      self.result = result
    }
  }

  /// A pair the player wants mixed, with everything the server plans and renders it from. Another value is another pair.
  public struct Pair: Sendable, Equatable {
    public var from: Track
    public var to: Track
    public var mode: MixMode
    /// The listener's fade length, for songs that can't be mixed on the beat.
    public var fade: Double
    /// The queue plays the songs' album: songs of one album in order go straight on.
    public var albumQueue: Bool
    /// The gains (dB) the phone plays the two songs at: the transition is made at them.
    public var levels: TransitionAnswer.Ready.Levels?
    public init(from: Track, to: Track, mode: MixMode, fade: Double, albumQueue: Bool, levels: TransitionAnswer.Ready.Levels?) {
      self.from = from
      self.to = to
      self.mode = mode
      self.fade = fade
      self.albumQueue = albumQueue
      self.levels = levels
    }
  }

  public private(set) var upcoming = Upcoming()

  /// Told whenever `upcoming` changes (the coordinator downloads a ready file, the Player picks the join again).
  @ObservationIgnored public var onChange: (@MainActor () -> Void)?

  /// Phase 7: a transition kept with a download, played instead of asking (offline, a Party queue takes Auto's).
  @ObservationIgnored public var kept: (@MainActor (Pair, _ online: Bool) -> TransitionAnswer?)?
  /// Told when the pair asked about changes (a new one, or none): downloads leave the player's pair to the player.
  @ObservationIgnored public var onPairChange: (@MainActor () -> Void)?

  private enum Ended { case answered, late, refused }

  private final class Asking {
    let pair: Pair
    var position: Double?
    var asks = 0
    var asking = false
    var timer: ScheduledAction?
    var aStart: Double?
    var polls = 0
    var errors = 0
    var askedAgainUnavailable = false
    var ended: Ended?
    init(_ pair: Pair) { self.pair = pair }
  }

  @ObservationIgnored private var pair: Asking?
  @ObservationIgnored private var playingFileId: Int?
  @ObservationIgnored private var restartToken: Int?
  @ObservationIgnored private var played = 0.0
  @ObservationIgnored private var time = 0.0
  @ObservationIgnored private var lastTime: Double?
  @ObservationIgnored private var lastAt: Date
  /// The ask on its way, if one is (tests wait for it).
  @ObservationIgnored private(set) var inFlight: Task<Void, Never>?
  /// Polls slow down while paused (the transition isn't needed soon).
  @ObservationIgnored public var isPlaying: @MainActor () -> Bool = { true }
  /// Offline, nothing is asked: `networkChanged()` asks once it's back.
  @ObservationIgnored public var isOnline: @MainActor () -> Bool = { true }
  @ObservationIgnored private let scheduler: any Scheduling
  @ObservationIgnored private let ask: @Sendable (TransitionRequest) async throws -> TransitionAnswer

  public init(scheduler: any Scheduling, ask: @escaping @Sendable (TransitionRequest) async throws -> TransitionAnswer) {
    self.scheduler = scheduler
    self.ask = ask
    lastAt = scheduler.now
  }

  // MARK: What the player tells it

  /// The pair wanted now (nil: none: not DJ mix, mixing off, no next song, the sleep timer ends this song), and the
  /// song playing with its restart token (its listening time starts over when either changes). A different pair
  /// starts over; the same one goes on.
  public func update(wanted: Pair?, playing: (fileId: Int, restartToken: Int)?) {
    if playing?.fileId != playingFileId || playing?.restartToken != restartToken {
      playingFileId = playing?.fileId
      restartToken = playing?.restartToken
      played = 0
      lastTime = nil
    }
    if wanted != pair?.pair {
      drop()
      if let wanted {
        let asking = Asking(wanted)
        pair = asking
        later(asking, Self.firstAskDelay)
      }
      upcoming = Upcoming(fromFileId: wanted?.from.fileId, toFileId: wanted?.to.fileId, result: nil)
      onPairChange?()
      onChange?()
    }
    maybeAsk()
  }

  /// The song's clock (the Player's 10 Hz tick), `seeked` when it jumped.
  public func clock(_ time: Double, seeked: Bool) {
    let now = scheduler.now
    let step = lastTime.map { time - $0 } ?? .nan
    let elapsed = now.timeIntervalSince(lastAt)
    // Listening moves the clock about as fast as time passes; a seek or a new song's reset doesn't.
    let listening = !seeked && step > 0 && step <= elapsed * 1.25 + 0.5
    if listening { played += step }
    // A seek or a restart can leave the answer behind; the clock settling as a transition takes over doesn't.
    let jumped = seeked || (!listening && !(abs(step) <= Self.settle))
    self.time = time
    lastTime = time
    lastAt = now
    guard let p = pair else { return }
    if jumped && outOfStep(p, time) {
      startOver(p)
    } else if p.ended == nil && tooLate(p) {
      return giveUp(p, .late)
    }
    maybeAsk()
  }

  /// A song's mix points were edited: if it's in the pair, the pair is asked for afresh (after its short wait).
  public func refresh(recordingId: String) {
    guard let p = pair, p.pair.from.recordingId == recordingId || p.pair.to.recordingId == recordingId else { return }
    let wanted = p.pair
    drop()
    let asking = Asking(wanted)
    pair = asking
    later(asking, Self.firstAskDelay)
    publish(nil)
  }

  /// The network came back (or went): ask if it's time.
  public func networkChanged() { maybeAsk() }

  // MARK: Asking

  private func tooLate(_ p: Asking) -> Bool { time >= (p.aStart ?? p.pair.from.duration) - Self.giveUp }

  private func publish(_ result: Result?) {
    upcoming.result = result
    onChange?()
  }

  private func later(_ p: Asking, _ seconds: Double) {
    p.timer?.cancel()
    p.timer = scheduler.schedule(after: seconds) { [weak self, weak p] in
      guard let p else { return }
      p.timer = nil
      self?.maybeAsk()
    }
  }

  private func drop() {
    pair?.timer?.cancel()
    pair = nil
  }

  private func giveUp(_ p: Asking, _ why: Ended) {
    p.timer?.cancel()
    p.timer = nil
    p.asking = false
    p.ended = why
    publish(.gaveUp)
  }

  private func startOver(_ p: Asking) {
    p.timer?.cancel()
    p.timer = nil
    p.position = nil
    p.aStart = nil
    p.asking = false
    p.ended = nil
    p.polls = 0
    p.errors = 0
    p.asks += 1
    publish(nil)
  }

  private func outOfStep(_ p: Asking, _ time: Double) -> Bool {
    switch upcoming.result {
    case .answer(.ready(let r)) where time >= r.plan.aStart - Self.readyLead: return true
    case .answer(.pending(let r)) where time >= r.plan.aStart - Self.giveUp: return true
    default: return p.ended == .late && time < (p.aStart ?? p.pair.from.duration) - Self.giveUp - Self.restartMargin
    }
  }

  private func maybeAsk() {
    guard let p = pair, p.ended == nil else { return }
    let online = isOnline()
    if let kept = kept?(p.pair, online), case .ready(let r) = kept, !online || time < r.plan.aStart - Self.giveUp {
      p.timer?.cancel()
      p.timer = nil
      p.asking = false
      p.asks += 1
      return answered(p, kept)
    }
    guard !p.asking, p.timer == nil, played >= Self.minPlayed, online else { return }
    if tooLate(p) { return giveUp(p, .late) }
    p.asking = true
    if p.position == nil { p.position = time }
    p.asks += 1
    let ask = p.asks
    let request = TransitionRequest(
      from: p.pair.from.id, to: p.pair.to.id, mode: p.pair.mode, position: p.position, fromFileId: p.pair.from.fileId,
      toFileId: p.pair.to.fileId, fade: p.pair.fade, albumQueue: p.pair.albumQueue, levels: p.pair.levels)
    let send = self.ask
    inFlight = Task { [weak self] in
      let outcome: Swift.Result<TransitionAnswer, any Error>
      do { outcome = .success(try await send(request)) } catch { outcome = .failure(error) }
      // The pair changed, started over or gave up meanwhile: this answer is for nothing now.
      guard let self, self.pair === p, p.asks == ask, p.ended == nil else { return }
      p.asking = false
      switch outcome {
      case .success(let answer):
        p.errors = 0
        self.answered(p, answer)
      case .failure(let error):
        self.failed(p, error)
      }
    }
  }

  private func answered(_ p: Asking, _ answer: TransitionAnswer) {
    switch answer {
    case .pending(let r): p.aStart = r.plan.aStart
    case .ready(let r): p.aStart = r.plan.aStart
    default: break
    }
    if case .pending = answer, tooLate(p) { return giveUp(p, .late) }
    if case .ready = answer, tooLate(p) { return giveUp(p, .late) }
    publish(.answer(answer))
    switch answer {
    case .pending:
      p.polls += 1
      later(p, p.polls >= Self.fastPolls || !isPlaying() ? Self.slowPollInterval : Self.pollInterval)
    case .unavailable where !p.askedAgainUnavailable:
      p.askedAgainUnavailable = true
      later(p, Self.unavailableRetry)
    default:
      p.ended = .answered
    }
  }

  private func failed(_ p: Asking, _ error: any Error) {
    // Offline: asked again when the network is back.
    guard isOnline() else { return }
    let status: Int
    switch error as? APIError {
    case .server(let code, _)?: status = code
    case .unauthorized?: status = 401
    default: status = 0  // a lost connection or an answer that didn't decode: likely to pass
    }
    if status == 0 || status == 429 || status >= 500 {
      later(p, Self.retryIntervals[min(p.errors, Self.retryIntervals.count - 1)])
      p.errors += 1
    } else {
      giveUp(p, .refused)
    }
  }
}
