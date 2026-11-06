import Foundation
import Testing
@testable import PlayarrUI

@MainActor @Suite struct ToastCenterTests {
  @Test func showsAMessageOnceAndOnlyThreeAtATime() {
    let toasts = ToastCenter(clock: TestClock())
    toasts.push("This file format is not supported on this device")
    toasts.push("This file format is not supported on this device")
    #expect(toasts.toasts.count == 1)
    for n in 2...4 { toasts.push("Added \(n) songs to the queue") }
    #expect(toasts.toasts.map(\.message) == ["Added 2 songs to the queue", "Added 3 songs to the queue", "Added 4 songs to the queue"])
  }

  @Test func goesAfterThreeAndAHalfSeconds() async {
    let clock = TestClock()
    let toasts = ToastCenter(clock: clock)
    toasts.push("Sleep timer: music stopped")
    #expect(await clock.nextSleep() == .milliseconds(3500))
    clock.advance(by: .milliseconds(3500))
    while !toasts.toasts.isEmpty { await Task.yield() }
    #expect(toasts.toasts.isEmpty)
  }

  @Test func anErrorStaysSevenSeconds() async {
    let clock = TestClock()
    let toasts = ToastCenter(clock: clock)
    toasts.push("Cannot reach the Playarr server", tone: .error)
    #expect(await clock.nextSleep() == .seconds(7))
  }

  @Test func aToastWithAButtonStaysUntilUsed() {
    let clock = TestClock()
    let toasts = ToastCenter(clock: clock)
    var reloaded = false
    toasts.push("A new version of Playarr is ready", action: .init("Reload") { reloaded = true })
    #expect(clock.pendingSleep == nil)
    toasts.perform(toasts.toasts[0])
    #expect(reloaded)
    #expect(toasts.toasts.isEmpty)
  }

  @Test func anUndoGoesAfterSixSecondsAndWhatWaitedGoesAhead() async {
    let clock = TestClock()
    let toasts = ToastCenter(clock: clock)
    var undone = false
    var done = false
    toasts.undo("Removed “Request” from Requests", undo: { undone = true }, done: { done = true })
    #expect(toasts.toasts.first?.action?.label == "Undo")
    #expect(await clock.nextSleep() == .seconds(6))
    clock.advance(by: .seconds(6))
    while !toasts.toasts.isEmpty { await Task.yield() }
    #expect(done)
    #expect(!undone)
  }

  @Test func undoingStopsWhatWaited() {
    let toasts = ToastCenter(clock: TestClock())
    var undone = false
    var done = false
    toasts.undo("Removed “Request” from Requests", undo: { undone = true }, done: { done = true })
    toasts.perform(toasts.toasts[0])
    #expect(undone)
    #expect(!done)
    #expect(toasts.toasts.isEmpty)
  }

  @Test func aRepeatWithUndoReplacesTheOneBefore() {
    let toasts = ToastCenter(clock: TestClock())
    var firstUndone = false
    var firstDone = false
    toasts.undo("“Angel” plays next", undo: { firstUndone = true }, done: { firstDone = true })
    let first = toasts.toasts[0].id
    toasts.undo("“Angel” plays next") {}
    #expect(toasts.toasts.count == 1)
    #expect(toasts.toasts[0].id != first)
    // The one before can no longer be taken back: what waited on it goes ahead.
    #expect(firstDone)
    #expect(!firstUndone)
  }

  @Test func aToastPushedOutLetsWhatWaitedGoAhead() {
    let toasts = ToastCenter(clock: TestClock())
    var done: [Int] = []
    for n in 1...4 { toasts.undo("Removed song \(n) from the queue", undo: {}, done: { done.append(n) }) }
    #expect(toasts.toasts.map(\.message) == ["Removed song 2 from the queue", "Removed song 3 from the queue", "Removed song 4 from the queue"])
    #expect(done == [1])
  }

  @Test func anUndoWaitsWhileHeldThenItsTimeStartsOver() async {
    let clock = TestClock()
    let toasts = ToastCenter(clock: clock)
    toasts.undo("“Angel” plays next") {}
    let id = toasts.toasts[0].id
    #expect(await clock.nextSleep() == .seconds(6))
    clock.advance(by: .seconds(4))
    toasts.hold(id, true)
    #expect(clock.sleeping == 0)
    clock.advance(by: .seconds(10))
    #expect(toasts.toasts.map(\.id) == [id])
    toasts.hold(id, false)
    #expect(await clock.nextSleep() == .seconds(6))
  }
}
