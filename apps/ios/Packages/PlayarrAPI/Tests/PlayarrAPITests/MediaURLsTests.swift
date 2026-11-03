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
}
