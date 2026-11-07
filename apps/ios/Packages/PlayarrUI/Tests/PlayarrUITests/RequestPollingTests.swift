import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct RequestPollingTests {
  @Test func pollsEveryTenSecondsWhileAnythingIsOnItsWay() {
    for s: AvailabilityState in [.searching, .downloading, .importing] {
      #expect(RequestPolling.interval(after: [albumRequest("a", "A", .available), albumRequest("b", "B", s)]) == .seconds(10))
    }
  }

  @Test func pollsEveryMinuteOtherwise() {
    #expect(RequestPolling.interval(after: nil) == .seconds(60))
    #expect(RequestPolling.interval(after: []) == .seconds(60))
    #expect(RequestPolling.interval(after: [albumRequest("a", "A", .waiting), albumRequest("b", "B", .failed), albumRequest("c", "C", .available)]) == .seconds(60))
  }

  @Test func countsWhatIsInProgress() {
    #expect(RequestPolling.activeCount([albumRequest("a", "A", .searching), albumRequest("b", "B", .downloading), albumRequest("c", "C", .waiting)]) == 2)
  }
}

@Suite struct RequestWatchTests {
  @Test func announcesNothingOnTheFirstLook() {
    var watch = RequestWatch()
    let first = watch.changes(in: [albumRequest("a", "Mezzanine", .available), waitingRequest("b", "Heligoland", mine: false)])
    #expect(first == RequestWatch.Changes())
  }

  @Test func announcesARequestThatBecamePlayableOnce() {
    var watch = RequestWatch()
    _ = watch.changes(in: [albumRequest("a", "Mezzanine", .downloading)])
    let landed = watch.changes(in: [albumRequest("a", "Mezzanine", .available, albumId: 7)]).landed
    #expect(landed.map(\.mbid) == ["a"])
    #expect(RequestWatch.message(for: landed) == "“Mezzanine” is ready to play")
    #expect(watch.changes(in: [albumRequest("a", "Mezzanine", .available, albumId: 7)]).landed.isEmpty)
  }

  @Test func countsSeveralAtOnce() {
    var watch = RequestWatch()
    _ = watch.changes(in: [albumRequest("a", "A", .importing), albumRequest("b", "B", .searching)])
    let landed = watch.changes(in: [albumRequest("a", "A", .available), albumRequest("b", "B", .available), albumRequest("c", "C", .available)]).landed
    #expect(landed.count == 3)
    #expect(RequestWatch.message(for: landed) == "3 albums are ready to play")
    #expect(RequestWatch.message(for: []) == nil)
  }

  @Test func tellsTheAskerOnlyOfTheirOwnThoughEveryoneLandsInTheLibrary() {
    var watch = RequestWatch()
    _ = watch.changes(in: [albumRequest("a", "A", .searching, mine: true), albumRequest("b", "B", .searching, mine: false), albumRequest("c", "C", .searching)])
    let changes = watch.changes(in: [
      albumRequest("a", "A", .available, mine: true), albumRequest("b", "B", .available, mine: false), albumRequest("c", "C", .available),
    ])
    #expect(changes.landed.map(\.mbid) == ["a", "b", "c"])
    // A server that predates ownership says nothing of it: every request was everyone's.
    #expect(changes.landedForYou.map(\.mbid) == ["a", "c"])
  }

  @Test func noticesSomeoneElsesRequestStartingToWaitOnce() {
    var watch = RequestWatch()
    _ = watch.changes(in: [albumRequest("a", "A", .searching, mine: false)])
    let changes = watch.changes(in: [
      albumRequest("a", "A", .searching, mine: false), waitingRequest("b", "B", mine: false, askedBy: ["Sam"]),
      // The account's own waits for someone else's answer: nothing for it to do.
      waitingRequest("c", "C", mine: true),
    ])
    #expect(changes.waiting.map(\.mbid) == ["b"])
    #expect(watch.changes(in: [waitingRequest("b", "B", mine: false, askedBy: ["Sam"])]).waiting.isEmpty)
  }

  @Test func saysWhoAskedOrHowManyWait() {
    #expect(RequestWatch.waitingMessage(for: []) == nil)
    #expect(RequestWatch.waitingMessage(for: [waitingRequest("a", "Heligoland", mine: false, askedBy: ["Sam"])]) == "Sam asked for “Heligoland”")
    #expect(RequestWatch.waitingMessage(for: [waitingRequest("a", "Heligoland", mine: false)]) == "“Heligoland” is waiting for your approval")
    let two = [waitingRequest("a", "Heligoland", mine: false), waitingRequest("b", "Mezzanine", mine: false)]
    #expect(RequestWatch.waitingMessage(for: two) == "2 albums are waiting for your approval")
  }
}
