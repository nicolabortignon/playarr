import Foundation
@testable import PlayarrPlayer

/// A clock moved by hand: `advance(by:)` runs what falls due, in order.
@MainActor
final class ManualScheduling: Scheduling {
  private(set) var now = Date(timeIntervalSince1970: 1_000_000)
  private var pending: [(at: Date, order: Int, action: ScheduledAction, run: @MainActor () -> Void)] = []
  private var order = 0

  @discardableResult
  func schedule(after seconds: Double, _ action: @escaping @MainActor () -> Void) -> ScheduledAction {
    let handle = ScheduledAction()
    order += 1
    pending.append((now.addingTimeInterval(seconds), order, handle, action))
    return handle
  }

  func advance(by seconds: Double) {
    let end = now.addingTimeInterval(seconds)
    while let next = pending.filter({ !$0.action.isCancelled && $0.at <= end }).min(by: { ($0.at, $0.order) < ($1.at, $1.order) }) {
      pending.removeAll { $0.order == next.order }
      now = max(now, next.at)
      next.run()
    }
    pending.removeAll { $0.action.isCancelled }
    now = end
  }

  /// Seconds until the next action falls due, if any.
  var nextDue: Double? {
    pending.filter { !$0.action.isCancelled }.map { $0.at.timeIntervalSince(now) }.min()
  }
}
