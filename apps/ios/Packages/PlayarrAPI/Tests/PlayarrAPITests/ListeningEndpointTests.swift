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

  @Test func changesOnlyWhatAPatchSays() throws {
    let stop = try body(API.Playlists.update(id: 5, shared: false))
    #expect(stop.keys.sorted() == ["shared"])
    #expect(stop["shared"] as? Bool == false)
    #expect(try body(API.Playlists.update(id: 5, name: "Night", description: "")).keys.sorted() == ["description", "name"])
  }
}
