import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct DiscoveredServerTests {
    @Test func readsTheTXTRecord() throws {
        let server = try #require(DiscoveredServer(txt: ["id": "srv-1", "v": "0.7.0", "name": "Home", "path": "/"], host: "192.168.1.103", port: 4000))
        #expect(server == DiscoveredServer(id: "srv-1", name: "Home", version: "0.7.0", baseURL: URL(string: "http://192.168.1.103:4000")!))
    }

    @Test func needsAnId() {
        #expect(DiscoveredServer(txt: ["name": "Home"], host: "192.168.1.103", port: 4000) == nil)
    }

    @Test func bracketsAnIPv6Address() throws {
        let server = try #require(DiscoveredServer(txt: ["id": "srv-1"], host: "fe80::1%en0", port: 4000))
        #expect(server.baseURL.absoluteString == "http://[fe80::1%25en0]:4000")
        #expect(server.name == "Playarr")
    }

    @Test func keepsOneEntryPerServer() {
        let a = DiscoveredServer(id: "srv-1", name: "Home", version: "0.7.0", baseURL: URL(string: "http://192.168.1.103:4000")!)
        let b = DiscoveredServer(id: "srv-1", name: "Home", version: "0.7.0", baseURL: URL(string: "http://192.168.1.104:4000")!)
        let c = DiscoveredServer(id: "srv-2", name: "Attic", version: "0.7.0", baseURL: URL(string: "http://192.168.1.20:4000")!)
        #expect(DiscoveredServer.merge(DiscoveredServer.merge([a], c), b) == [c, b])
    }
}
