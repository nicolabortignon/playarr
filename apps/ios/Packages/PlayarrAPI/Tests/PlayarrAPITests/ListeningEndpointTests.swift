import Foundation
import Testing
@testable import PlayarrAPI

/// Playlists can be shared with everyone on the server (phase 1's `shared`), from the app too.
@Suite struct ListeningEndpointTests {
  private func body<T>(_ endpoint: Endpoint<T>) throws -> [String: Any] {
    let data = try #require(try endpoint.bodyData())
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  @Test func sharesAPlaylistOnlyWhenAsked() throws {
    #expect(try body(API.Playlists.create(name: "Road trip")).keys.sorted() == ["name"])
    let shared = try body(API.Playlists.create(name: "Road trip", recordingIds: ["track:1"], shared: true))
    #expect(shared["shared"] as? Bool == true)
    #expect(shared["recordingIds"] as? [String] == ["track:1"])
  }

  @Test func asksWhichPlaylistsHoldTheSongs() throws {
    let endpoint = API.Playlists.holding(recordingIds: ["rec-1", "rec-2"])
    #expect(endpoint.method == .post)
    #expect(endpoint.path == "/api/playlists/holding")
    #expect(try body(endpoint)["recordingIds"] as? [String] == ["rec-1", "rec-2"])
    // The server's answer: playlist ids as the object's keys, those holding none left out.
    let answer = try JSONDecoder().decode(PlaylistsHolding.self, from: Data(#"{"holding":{"5":2,"12":1}}"#.utf8))
    #expect(answer.count(5) == 2)
    #expect(answer.count(12) == 1)
    #expect(answer.count(7) == 0)
  }

  @Test func changesOnlyWhatAPatchSays() throws {
    let stop = try body(API.Playlists.update(id: 5, shared: false))
    #expect(stop.keys.sorted() == ["shared"])
    #expect(stop["shared"] as? Bool == false)
    #expect(try body(API.Playlists.update(id: 5, name: "Night", description: "")).keys.sorted() == ["description", "name"])
  }
}
