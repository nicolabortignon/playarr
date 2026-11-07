import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct RequestRowTextTests {
  let english = Locale(identifier: "en_US")
  let now = Format.parseDate("2026-11-03T12:00:00.000Z")!

  @Test func saysHowLongAgoTheWebsWay() {
    #expect(RequestRowText.ago("2026-11-03T11:59:30.000Z", now: now, locale: english) == "just now")
    #expect(RequestRowText.ago("2026-11-03T11:55:00Z", now: now, locale: english) == "5 minutes ago")
    #expect(RequestRowText.ago("2026-11-03T10:00:00.000Z", now: now, locale: english) == "2 hours ago")
    #expect(RequestRowText.ago("2026-11-02T12:00:00.000Z", now: now, locale: english) == "yesterday")
    #expect(RequestRowText.ago("2026-10-30T12:00:00.000Z", now: now, locale: english) == "4 days ago")
  }

  @Test func showsLidarrsMessageElseTheState() {
    var request = albumRequest("rg-1", "Mezzanine", .searching)
    #expect(RequestRowText.status(request, now: now, locale: english) == "searching · requested 2 hours ago")
    request.availability = availability(.available, albumId: 70)
    #expect(RequestRowText.status(request, now: now, locale: english) == "Ready to play · requested 2 hours ago")
    request.availability = availability(.downloading, message: "Downloading 2 of 12")
    #expect(RequestRowText.status(request, now: now, locale: english) == "Downloading 2 of 12 · requested 2 hours ago")
  }

  @Test func namesWhoAskedOnAnAdminsList() {
    let sams = waitingRequest("rg-1", "Heligoland", mine: false, askedBy: ["Sam"])
    #expect(RequestRowText.status(sams, now: now, locale: english) == "Waiting for approval · requested by Sam 2 hours ago")
    let shared = albumRequest("rg-2", "Mezzanine", .searching, mine: true, askedBy: ["Sam", "Zoe"])
    #expect(RequestRowText.requested(shared, now: now, locale: english) == "requested by you, Sam and Zoe 2 hours ago")
    // The admin's own, asked for by nobody else, and a member's list, which never names anyone.
    let own = albumRequest("rg-3", "Blue Lines", .searching, mine: true, askedBy: [])
    #expect(RequestRowText.requested(own, now: now, locale: english) == "requested 2 hours ago")
    #expect(RequestRowText.requested(albumRequest("rg-4", "Protection", .searching, mine: true), now: now, locale: english) == "requested 2 hours ago")
  }
}
