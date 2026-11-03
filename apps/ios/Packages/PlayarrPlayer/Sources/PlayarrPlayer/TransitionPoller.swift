import Foundation
import PlayarrAPI

/// Asks for a pair's transition until it's rendered, as `askUntilRendered` in apps/web/src/player/downloads.ts: every
/// 3 s for 5 polls, then every 10 s (renders queue up behind the player's own), giving up after 10 minutes. Asking
/// again also puts the pair back in the server's queue, should newer asks have pushed it out.
public struct TransitionPoller: Sendable {
  public struct Timing: Sendable {
    public var poll: Duration
    public var slowPoll: Duration
    public var fastPolls: Int
    public var giveUp: Duration

    public init(poll: Duration, slowPoll: Duration, fastPolls: Int, giveUp: Duration) {
      self.poll = poll
      self.slowPoll = slowPoll
      self.fastPolls = fastPolls
      self.giveUp = giveUp
    }

    public static let server = Timing(poll: .seconds(3), slowPoll: .seconds(10), fastPolls: 5, giveUp: .seconds(10 * 60))
  }

  public enum Outcome: Sendable, Equatable {
    case ready(TransitionAnswer.Ready)
    /// Why there's none to keep (left out this session).
    case none(String)
  }

  public let timing: Timing

  public init(timing: Timing = .server) { self.timing = timing }

  /// Throws the ask's errors, and `CancellationError` when the task is cancelled.
  public func ask(_ request: @Sendable () async throws -> TransitionAnswer) async throws -> Outcome {
    let clock = ContinuousClock()
    let started = clock.now
    var polls = 0
    while true {
      let answer = try await request()
      try Task.checkCancellation()
      switch answer {
      case .ready(let ready): return .ready(ready)
      case .unavailable(let unavailable): return .none(unavailable.reason)
      case .straight: return .none("No transition: the songs play straight on")
      case .unknown(let status): return .none("Unknown answer: \(status)")
      case .pending: break
      }
      if clock.now - started >= timing.giveUp { return .none("The transition took too long to render") }
      try await Task.sleep(for: polls < timing.fastPolls ? timing.poll : timing.slowPoll)
      polls += 1
    }
  }
}
