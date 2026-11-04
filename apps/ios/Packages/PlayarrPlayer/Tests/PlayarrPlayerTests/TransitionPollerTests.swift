import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrPlayer

struct TransitionPollerTests {
  let quick = TransitionPoller.Timing(poll: .milliseconds(1), slowPoll: .milliseconds(3), fastPolls: 5, giveUp: .milliseconds(200))
  /// Polls as quick, but with all the time a busy CI machine needs to get through them before giving up.
  let patient = TransitionPoller.Timing(poll: .milliseconds(1), slowPoll: .milliseconds(3), fastPolls: 5, giveUp: .seconds(60))

  /// Answers in turn, the last one repeating.
  final class Answers: Sendable {
    let left: Mutex<[TransitionAnswer]>
    let asked = Mutex(0)
    init(_ answers: [TransitionAnswer]) { left = Mutex(answers) }
    func next() -> TransitionAnswer {
      asked.withLock { $0 += 1 }
      return left.withLock { $0.count > 1 ? $0.removeFirst() : $0[0] }
    }
  }

  @Test func pollsWhileItRendersAndKeepsTheReadyAnswer() async throws {
    let answers = Answers(Array(repeating: .pending(.init(plan: longPlan)), count: 7) + [.ready(ready(4, 5))])
    let outcome = try await TransitionPoller(timing: patient).ask { answers.next() }
    #expect(outcome == .ready(ready(4, 5)))
    #expect(answers.asked.withLock { $0 } == 8)
  }

  @Test func givesUpAfterItsTimeAndSaysWhyThereIsNone() async throws {
    let slow = Answers([.pending(.init(plan: longPlan))])
    #expect(try await TransitionPoller(timing: quick).ask { slow.next() } == .none("The transition took too long to render"))
    let none = Answers([.unavailable(.init(reason: "No mix map yet"))])
    #expect(try await TransitionPoller(timing: quick).ask { none.next() } == .none("No mix map yet"))
    let straight = Answers([.straight(.init(plan: longPlan))])
    #expect(try await TransitionPoller(timing: quick).ask { straight.next() } == .none("No transition: the songs play straight on"))
  }

  @Test func waitsThreeSecondsFiveTimesThenTen() {
    #expect(TransitionPoller.Timing.server.poll == .seconds(3))
    #expect(TransitionPoller.Timing.server.slowPoll == .seconds(10))
    #expect(TransitionPoller.Timing.server.fastPolls == 5)
    #expect(TransitionPoller.Timing.server.giveUp == .seconds(600))
  }
}
