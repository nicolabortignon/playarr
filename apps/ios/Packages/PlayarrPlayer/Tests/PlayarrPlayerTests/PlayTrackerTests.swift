import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// Ported from apps/web/src/player/playTracker.test.ts.
struct PlayTrackerTests {
  final class Sent { var plays: [PlayReport] = [] }

  /// Play from `from` to `to` seconds in quarter-second ticks, as the player's clock does.
  func listen(_ t: PlayTracker, _ from: Double, _ to: Double) {
    for s in stride(from: from, through: to, by: 0.25) { t.tick(s) }
  }

  var calendar: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "Europe/London")!
    return c
  }

  @Test func aSongHeardForThirtySecondsIsAPlayWithTheLocalHourAndWeekday() {
    let sent = Sent()
    let t = PlayTracker(calendar: calendar) { sent.plays += $0 }
    let at = calendar.date(from: DateComponents(year: 2026, month: 11, day: 1, hour: 21, minute: 15))!  // a Sunday
    t.start(song(7, duration: 240), at: at)
    listen(t, 0, 31)
    t.finish(.changed)
    #expect(sent.plays == [PlayReport(trackId: 7, recordingId: "rec-7", at: "2026-11-01T21:15:00.000Z", hour: 21, weekday: 0, seconds: 31, skipped: false)])
  }

  @Test func onlyWhatWasHeardCountsSeekingAheadIsNotListening() {
    let sent = Sent()
    let t = PlayTracker { sent.plays += $0 }
    t.start(song(7, duration: 240))
    listen(t, 0, 10)
    t.pause()  // seeking
    listen(t, 200, 205)
    t.finish(.changed)
    #expect(sent.plays.first?.skipped == true)
    #expect(sent.plays.first?.seconds == 15)
  }

  @Test func aShortSongHeardHalfwayIsAPlayLeavingInTheFirstSecondsIsNothing() {
    let sent = Sent()
    let t = PlayTracker { sent.plays += $0 }
    t.start(song(7, duration: 40))
    listen(t, 0, 21)
    t.finish(.ended)
    t.start(song(8, duration: 240))
    listen(t, 0, 2)
    t.finish(.changed)
    #expect(sent.plays.count == 1)
    #expect(sent.plays.first?.skipped == false)
  }

  @Test func closingTheAppMidSongIsNeverASkip() {
    let sent = Sent()
    let t = PlayTracker { sent.plays += $0 }
    t.start(song(7, duration: 240))
    listen(t, 0, 10)
    t.finish(.closed)
    #expect(sent.plays.isEmpty)
  }
}
