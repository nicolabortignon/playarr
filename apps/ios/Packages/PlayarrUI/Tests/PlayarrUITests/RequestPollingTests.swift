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
    #expect(watch.landed(in: [albumRequest("a", "Mezzanine", .available)]).isEmpty)
  }

  @Test func announcesARequestThatBecamePlayableOnce() {
    var watch = RequestWatch()
    _ = watch.landed(in: [albumRequest("a", "Mezzanine", .downloading)])
    let landed = watch.landed(in: [albumRequest("a", "Mezzanine", .available, albumId: 7)])
    #expect(landed.map(\.mbid) == ["a"])
    #expect(RequestWatch.message(for: landed) == "“Mezzanine” is ready to play")
    #expect(watch.landed(in: [albumRequest("a", "Mezzanine", .available, albumId: 7)]).isEmpty)
  }

  @Test func countsSeveralAtOnce() {
    var watch = RequestWatch()
    _ = watch.landed(in: [albumRequest("a", "A", .importing), albumRequest("b", "B", .searching)])
    let landed = watch.landed(in: [albumRequest("a", "A", .available), albumRequest("b", "B", .available), albumRequest("c", "C", .available)])
    #expect(landed.count == 3)
    #expect(RequestWatch.message(for: landed) == "3 albums are ready to play")
    #expect(RequestWatch.message(for: []) == nil)
  }
}
