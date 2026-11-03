import Foundation

/// Waits on the wall clock for the player's timers (asking for transitions, polling mix maps), so tests can move the
/// clock by hand (`ManualScheduling` in the tests) instead of sleeping.
@MainActor
public protocol Scheduling: AnyObject {
  var now: Date { get }
  /// Runs `action` after `seconds`, unless cancelled first.
  @discardableResult func schedule(after seconds: Double, _ action: @escaping @MainActor () -> Void) -> ScheduledAction
}

/// A pending action of a `Scheduling`.
@MainActor
public final class ScheduledAction {
  public private(set) var isCancelled = false
  private let onCancel: () -> Void

  public init(onCancel: @escaping () -> Void = {}) { self.onCancel = onCancel }

  public func cancel() {
    guard !isCancelled else { return }
    isCancelled = true
    onCancel()
  }
}

/// The real clock: a task that sleeps.
@MainActor
public final class TaskScheduling: Scheduling {
  public init() {}

  public var now: Date { Date() }

  @discardableResult
  public func schedule(after seconds: Double, _ action: @escaping @MainActor () -> Void) -> ScheduledAction {
    let task = Task { @MainActor in
      try? await Task.sleep(for: .seconds(max(0, seconds)))
      guard !Task.isCancelled else { return }
      action()
    }
    return ScheduledAction { task.cancel() }
  }
}
