import Foundation
import Testing
@testable import PlayarrUI

@MainActor @Suite struct ToastCenterTests {
  @Test func showsAMessageOnceAndOnlyThreeAtATime() {
    let toasts = ToastCenter(clock: TestClock())
    toasts.push("Playing 1 track next")
    toasts.push("Playing 1 track next")
    #expect(toasts.toasts.count == 1)
    for n in 2...4 { toasts.push("Added \(n) tracks to queue") }
    #expect(toasts.toasts.map(\.message) == ["Added 2 tracks to queue", "Added 3 tracks to queue", "Added 4 tracks to queue"])
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
    var undone = false
    toasts.push("Cleared 3 tracks", action: .init("Undo") { undone = true })
    #expect(clock.pendingSleep == nil)
    toasts.perform(toasts.toasts[0])
    #expect(undone)
    #expect(toasts.toasts.isEmpty)
  }
}
