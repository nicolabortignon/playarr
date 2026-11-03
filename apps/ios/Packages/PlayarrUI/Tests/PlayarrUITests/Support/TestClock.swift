import Synchronization

/// A clock that only moves when a test says so. `nextSleep()` waits until something sleeps on it and
/// says for how long; `advance(by:)` wakes whoever's time has come. Polling loops are then followed step
/// by step: a loop only sleeps again once its refresh has finished.
final class TestClock: Clock, @unchecked Sendable {
  struct Instant: InstantProtocol, Hashable {
    var offset: Duration

    func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
    func duration(to other: Instant) -> Duration { other.offset - offset }
    static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
  }

  private struct Sleeper {
    let id: Int
    let deadline: Instant
    let continuation: CheckedContinuation<Void, any Error>
  }

  private struct State {
    var now = Instant(offset: .zero)
    var sleepers: [Sleeper] = []
    var watchers: [CheckedContinuation<Void, Never>] = []
    var cancelled: Set<Int> = []
    var nextId = 0
  }

  private let state = Mutex(State())

  var now: Instant { state.withLock { $0.now } }
  var minimumResolution: Duration { .zero }

  func sleep(until deadline: Instant, tolerance: Duration?) async throws {
    let id = state.withLock { state in
      state.nextId += 1
      return state.nextId
    }
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
        let (watchers, outcome): ([CheckedContinuation<Void, Never>], Result<Void, any Error>?) = state.withLock { state in
          if state.cancelled.remove(id) != nil { return ([], .failure(CancellationError())) }
          if deadline <= state.now { return ([], .success(())) }
          state.sleepers.append(Sleeper(id: id, deadline: deadline, continuation: continuation))
          defer { state.watchers = [] }
          return (state.watchers, nil)
        }
        if let outcome { continuation.resume(with: outcome) }
        for watcher in watchers { watcher.resume() }
      }
    } onCancel: {
      let sleeper: Sleeper? = state.withLock { state in
        guard let index = state.sleepers.firstIndex(where: { $0.id == id }) else {
          state.cancelled.insert(id)
          return nil
        }
        return state.sleepers.remove(at: index)
      }
      sleeper?.continuation.resume(throwing: CancellationError())
    }
  }

  /// Waits until something sleeps on this clock, and says how long it asked to sleep for.
  func nextSleep() async -> Duration {
    while true {
      if let wait = pendingSleep { return wait }
      await withCheckedContinuation { (watcher: CheckedContinuation<Void, Never>) in
        let ready = state.withLock { state in
          if state.sleepers.isEmpty {
            state.watchers.append(watcher)
            return false
          }
          return true
        }
        if ready { watcher.resume() }
      }
    }
  }

  /// How long the first sleeper still has to sleep, if something is sleeping.
  var pendingSleep: Duration? {
    state.withLock { state in state.sleepers.first.map { state.now.duration(to: $0.deadline) } }
  }

  /// Moves time on and wakes whoever's deadline has come.
  func advance(by duration: Duration) {
    let due: [Sleeper] = state.withLock { state in
      state.now = state.now.advanced(by: duration)
      let now = state.now
      let due = state.sleepers.filter { $0.deadline <= now }
      state.sleepers.removeAll { $0.deadline <= now }
      return due
    }
    for sleeper in due { sleeper.continuation.resume() }
  }
}
