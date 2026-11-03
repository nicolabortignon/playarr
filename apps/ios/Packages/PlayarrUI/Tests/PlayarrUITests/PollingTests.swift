import Testing
@testable import PlayarrUI

@MainActor @Suite struct PollingTests {
  @Test func refreshesThenWaitsTheIntervalUntilItSaysStop() async {
    let clock = TestClock()
    var refreshes = 0
    var interval: Duration? = .seconds(4)
    let task = Task { await Polling.run(clock: clock, interval: { interval }, refresh: { refreshes += 1 }) }
    #expect(await clock.nextSleep() == .seconds(4))
    #expect(refreshes == 1)
    interval = nil
    clock.advance(by: .seconds(4))
    await task.value
    #expect(refreshes == 2)
  }

  @Test func stopsWhenCancelled() async {
    let clock = TestClock()
    let task = Task { await Polling.run(clock: clock, interval: { .seconds(4) }, refresh: {}) }
    _ = await clock.nextSleep()
    task.cancel()
    await task.value
    #expect(clock.pendingSleep == nil)
  }
}
