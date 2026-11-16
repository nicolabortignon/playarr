import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct DeviceLinkTests {
    @Test func readsTheServerAndTheCodeAsTheTVShowsIt() throws {
        let link = try #require(DeviceLink(URL(string: "playarr://link?server=http%3A%2F%2Fnas.local%3A4000&code=abcd-2345")!))
        #expect(link.server.absoluteString == "http://nas.local:4000")
        #expect(link.code == "ABCD2345")
        #expect(link.shownCode == "ABCD 2345")
        #expect(link.webPage?.absoluteString == "http://nas.local:4000/link?code=ABCD2345")
    }

    @Test func ignoresOtherLinksAndCodesOfTheWrongLength() {
        #expect(DeviceLink(URL(string: "playarr://link?code=ABCD2345")!) == nil)
        #expect(DeviceLink(URL(string: "playarr://link?server=http%3A%2F%2Fnas.local&code=ABC")!) == nil)
        #expect(DeviceLink(URL(string: "playarr://link?server=ftp%3A%2F%2Fnas.local&code=ABCD2345")!) == nil)
        #expect(DeviceLink(URL(string: "playarr://redeem?server=http%3A%2F%2Fnas.local&code=ABCD2345")!) == nil)
        #expect(DeviceLink(URL(string: "https://nas.local/link?code=ABCD2345")!) == nil)
    }
}
