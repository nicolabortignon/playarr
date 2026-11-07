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

  @Test func waitsForTheAppToComeBackBeforeAskingAgain() async {
    let clock = TestClock()
    let activity = AppActivity(inForeground: true)
    var refreshes = 0
    let task = Task { await Polling.run(clock: clock, activity: activity, interval: { .seconds(4) }, refresh: { refreshes += 1 }) }
    _ = await clock.nextSleep()
    activity.set(inForeground: false)
    clock.advance(by: .seconds(4))
    // Its wait is over, but the app is in the background: nothing asked, no new wait.
    for _ in 0..<20 { await Task.yield() }
    #expect(refreshes == 1)
    #expect(clock.pendingSleep == nil)
    activity.set(inForeground: true)
    #expect(await clock.nextSleep() == .seconds(4))
    #expect(refreshes == 2)
    task.cancel()
    await task.value
  }

  @Test func aScreenClosedInTheBackgroundStopsWaiting() async {
    let clock = TestClock()
    let activity = AppActivity(inForeground: true)
    let task = Task { await Polling.run(clock: clock, activity: activity, interval: { .seconds(4) }, refresh: {}) }
    _ = await clock.nextSleep()
    activity.set(inForeground: false)
    clock.advance(by: .seconds(4))
    for _ in 0..<20 { await Task.yield() }
    task.cancel()
    await task.value
    #expect(clock.pendingSleep == nil)
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
