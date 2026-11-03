import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct RedeemLinkTests {
    @Test func readsTheServerAndTheCode() throws {
        let link = try #require(RedeemLink(URL(string: "playarr://redeem?server=https%3A%2F%2Fmusic.example.com&code=K7PQ2MXA")!))
        #expect(link.server.absoluteString == "https://music.example.com")
        #expect(link.code == "K7PQ2MXA")
    }

    @Test func ignoresOtherLinks() {
        #expect(RedeemLink(URL(string: "playarr://redeem?code=K7PQ2MXA")!) == nil)
        #expect(RedeemLink(URL(string: "playarr://album/12")!) == nil)
        #expect(RedeemLink(URL(string: "https://music.example.com/redeem?code=X")!) == nil)
    }
}
