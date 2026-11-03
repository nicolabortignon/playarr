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
}
