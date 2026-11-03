/// Asks the server again and again while a screen is up: `refresh`, then wait `interval()` on `clock`,
/// until the task is cancelled (the screen went away) or `interval()` says nil (nothing to follow).
@MainActor
enum Polling {
  static func run(clock: any Clock<Duration>, interval: () -> Duration?, refresh: () async -> Void) async {
    while !Task.isCancelled {
      await refresh()
      guard let wait = interval() else { return }
      do {
        try await clock.sleep(for: wait)
      } catch {
        return
      }
    }
  }
}
