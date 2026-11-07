import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct MediaURLsTests {
    let media = MediaURLs(baseURL: URL(string: "https://music.example.com/playarr")!, token: "tok")

    @Test func buildsMediaAddressesOnTheServer() {
        #expect(media.stream(fileId: 9000)?.absoluteString == "https://music.example.com/playarr/stream/9000")
        #expect(media.transition("/transitions/abc.flac")?.absoluteString == "https://music.example.com/playarr/transitions/abc.flac")
        #expect(media.art("/art/album/70/cover", size: 600)?.absoluteString == "https://music.example.com/playarr/art/album/70/cover?size=600")
        #expect(media.art("/art/playlist/3?v=abc", size: 128)?.absoluteString == "https://music.example.com/playarr/art/playlist/3?v=abc&size=128")
        #expect(media.art(nil, size: 128) == nil)
    }

    @Test func levelsASongOnTheServer() {
        let track = Track(id: 700, recordingId: "rec-1", fileId: 9000, albumId: 70, artistId: 7, title: "Angel", artistName: "Massive Attack", albumTitle: "Mezzanine", trackNumber: 1, discNumber: 1, duration: 379, explicit: false, format: AudioFormat(codec: "FLAC", container: "flac", lossless: true), size: 1, streamUrl: "/stream/9000")
        #expect(media.levelled(track, gain: -4.5)?.absoluteString == "https://music.example.com/playarr/stream/9000/levelled.wav?gain=-4.5")
    }

    @Test func putsTheTokenInTheHeaderNeverInTheURL() throws {
        let url = try #require(media.stream(fileId: 1))
        #expect(!url.absoluteString.contains("tok"))
        #expect(media.request(for: url).value(forHTTPHeaderField: "Authorization") == "Bearer tok")
    }

    @Test func keepsTheTokenFromOtherSites() throws {
        let elsewhere = try #require(media.url("https://coverartarchive.org/release/x/front"))
        #expect(media.request(for: elsewhere).value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func movesAddressesToTheHomeAddress() throws {
        let home = HomeAddress(url: URL(string: "http://192.168.1.103:4000")!, token: "tok", network: LocalNetwork(isLocal: true))
        let media = MediaURLs(baseURL: URL(string: "https://tracklist.me")!, home: home, token: "tok")
        let stream = try #require(media.stream(fileId: 9000))
        #expect(media.onLocalAddress(stream)?.absoluteString == "http://192.168.1.103:4000/stream/9000")
        #expect(media.onLocalAddress(try #require(media.art("/art/album/70/cover?v=2", size: 600)))?.absoluteString == "http://192.168.1.103:4000/art/album/70/cover?v=2&size=600")
        #expect(media.onLocalAddress(URL(string: "https://coverartarchive.org/x")!) == nil)
        #expect(self.media.onLocalAddress(stream) == nil)
    }

    @Test func sendsTheTokenToTheHomeAddressOnlyWhileItsProven() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { proofAnswer($0, holding: ["tok"]) ?? (404, Data()) }
        let network = LocalNetwork(isLocal: true)
        let home = HomeAddress(url: URL(string: "http://\(host):4000")!, token: "tok", session: session, network: network)
        let media = MediaURLs(baseURL: URL(string: "https://tracklist.me")!, home: home, token: "tok")
        let stream = try #require(media.stream(fileId: 9000))
        let local = try #require(media.onLocalAddress(stream))
        #expect(media.request(for: local).value(forHTTPHeaderField: "Authorization") == nil)

        #expect(await media.onHomeAddress(stream) == local)
        #expect(media.request(for: local).value(forHTTPHeaderField: "Authorization") == "Bearer tok")

        // Another network: not until it's proven there too.
        network.change(isLocal: true)
        #expect(media.request(for: local).value(forHTTPHeaderField: "Authorization") == nil)
        #expect(media.request(for: stream).value(forHTTPHeaderField: "Authorization") == "Bearer tok")
    }

    @Test func givesNoHomeAddressThatCantProveItself() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in (404, json(#"{"error":"Not found"}"#)) }
        let home = HomeAddress(url: URL(string: "http://\(host):4000")!, token: "tok", session: session, network: LocalNetwork(isLocal: true))
        let media = MediaURLs(baseURL: URL(string: "https://tracklist.me")!, home: home, token: "tok")
        let stream = try #require(media.stream(fileId: 9000))
        #expect(await media.onHomeAddress(stream) == nil)
        #expect(media.request(for: try #require(media.onLocalAddress(stream))).value(forHTTPHeaderField: "Authorization") == nil)
    }
}
