import Foundation
import Testing
@testable import PlayarrUI

@Suite struct AdminTextTests {
  @Test func saysCountsTheWebsWay() {
    #expect(AdminText.plural(1, "song") == "1 song")
    #expect(AdminText.plural(3, "album") == "3 albums")
    #expect(AdminText.count(5678) == "5,678")
  }

  @Test func saysSizes() {
    #expect(AdminText.bytes(356_515_840) == "340 MB")
    #expect(AdminText.bytes(1_610_612_736) == "1.5 GB")
    #expect(AdminText.bytes(12 * 1_073_741_824) == "12 GB")
  }

  @Test func saysHowLongAgo() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    #expect(AdminText.ago(1_800_000_000 - 20, now: now) == "just now")
    #expect(AdminText.ago(1_800_000_000 - 120, now: now) == "2 minutes ago")
    #expect(AdminText.ago(1_800_000_000 - 3_600, now: now) == "1 hour ago")
    #expect(AdminText.ago(1_800_000_000 - 86_400, now: now) == "yesterday")
    #expect(AdminText.ago(1_800_000_000 - 3 * 86_400, now: now) == "3 days ago")
  }
}
