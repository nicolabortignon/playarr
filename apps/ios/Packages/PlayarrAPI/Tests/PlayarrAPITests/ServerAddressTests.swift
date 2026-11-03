import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct ServerAddressTests {
    @Test(arguments: [
        ("192.168.1.103:4000", "http://192.168.1.103:4000"),
        ("playarr.local:4000/", "http://playarr.local:4000"),
        ("localhost:4000", "http://localhost:4000"),
        ("nas:4000", "http://nas:4000"),
        ("music.example.com", "https://music.example.com"),
        (" https://music.example.com/playarr/ ", "https://music.example.com/playarr"),
        ("http://10.0.0.2:4000", "http://10.0.0.2:4000"),
    ])
    func readsWhatWasTyped(typed: String, url: String) throws {
        #expect(try ServerAddress.url(from: typed).absoluteString == url)
    }

    @Test func wantsHTTPSOutsideTheHomeNetwork() {
        #expect(throws: ServerAddress.Problem.needsHTTPS) { try ServerAddress.url(from: "http://music.example.com") }
        #expect(throws: ServerAddress.Problem.needsHTTPS) { try ServerAddress.url(from: "http://203.0.113.5:4000") }
    }

    @Test func turnsAwayNothingAndNonsense() {
        #expect(throws: ServerAddress.Problem.empty) { try ServerAddress.url(from: "  ") }
        #expect(throws: ServerAddress.Problem.invalid) { try ServerAddress.url(from: "ftp://nas") }
    }
}
