import Foundation

/// Asks the server again and again while a screen is up: `refresh`, then wait `interval()` on `clock`,
/// until the task is cancelled (the screen went away) or `interval()` says nil (nothing to follow). In the background
/// it waits for the app to come back before asking again (`AppActivity`).
@MainActor
enum Polling {
  static func run(
    clock: any Clock<Duration>, activity: AppActivity = .shared, interval: () -> Duration?, refresh: () async -> Void
  ) async {
    while !Task.isCancelled {
      await refresh()
      guard let wait = interval() else { return }
      do {
        try await clock.sleep(for: wait)
      } catch {
        return
      }
      await activity.untilForeground()
    }
  }
}

/// Whether the app is in the foreground (plan 3 §2). With music playing in the background the app keeps running, and
/// screens left open would go on asking the server for what nobody sees: their polling waits here instead, and asks at
/// once when the app comes back. The requests' watch doesn't: it tells of albums that arrived. AppShell sets it from
/// the scene's phase.
@MainActor
public final class AppActivity {
  public static let shared = AppActivity()

  public private(set) var inForeground: Bool
  private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

  public init(inForeground: Bool = true) {
    self.inForeground = inForeground
  }

  public func set(inForeground: Bool) {
    self.inForeground = inForeground
    guard inForeground else { return }
    let ready = waiters
    waiters = [:]
    for waiter in ready.values { waiter.resume() }
  }

  /// Returns once the app is in the foreground (at once if it is), or the task is cancelled.
  func untilForeground() async {
    guard !inForeground else { return }
    let id = UUID()
    await withTaskCancellationHandler {
      await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
        if inForeground || Task.isCancelled { c.resume() } else { waiters[id] = c }
      }
    } onCancel: {
      Task { @MainActor in self.waiters.removeValue(forKey: id)?.resume() }
    }
  }
}
