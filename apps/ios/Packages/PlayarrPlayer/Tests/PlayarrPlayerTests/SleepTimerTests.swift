import Foundation
import Testing
@testable import PlayarrPlayer

/// Ported from apps/web/src/player/sleep.test.ts.
@MainActor
struct SleepTimerTests {
  @Test func fadesOutOverTheLastSecondsAndSaysHowLongIsLeft() {
    let now = Date(timeIntervalSince1970: 1_000)
    let timer = SleepTimer()
    timer.sleep(minutes: 10, from: now)
    #expect(timer.gain(at: now) == 1)
    #expect(abs(timer.gain(at: now + 600 - SleepTimer.fadeSeconds / 2) - 0.5) < 1e-6)
    #expect(timer.gain(at: now + 660) == 0)
    #expect(timer.label(at: now) == "10 min")
    timer.sleep(minutes: 90, from: now)
    #expect(timer.label(at: now) == "1 h 30 min")
    timer.sleep(minutes: 60, from: now)
    #expect(timer.label(at: now) == "1 h")
    timer.sleepAtEndOfSong()
    #expect(timer.label() == "End of song")
    timer.cancel()
    #expect(timer.gain() == 1)
    #expect(timer.label() == nil)
  }

  @Test func stopsOnceAtTheEndOfTheSong() {
    let timer = SleepTimer()
    timer.sleepAtEndOfSong()
    #expect(timer.stopsAtSongEnd())
    #expect(!timer.stopsAtSongEnd())
  }

  @Test func runsOutOnce() {
    let now = Date(timeIntervalSince1970: 0)
    let timer = SleepTimer()
    timer.sleep(minutes: 1, from: now)
    #expect(!timer.runsOut(at: now + 59))
    #expect(timer.runsOut(at: now + 60))
    #expect(!timer.runsOut(at: now + 61))
    #expect(timer.endsAt == nil)
  }
}
