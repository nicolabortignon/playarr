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
    let open = try body(API.Playlists.update(id: 5, collaborative: true))
    #expect(open.keys.sorted() == ["collaborative"])
    #expect(open["collaborative"] as? Bool == true)
  }

  /// A server from before collaborative playlists says nothing of them, and its playlists still decode.
  @Test func readsAPlaylistFromAServerThatDoesntSayWhoAddsToIt() throws {
    let json = #"""
      {"id":5,"name":"Road trip","description":"","trackCount":1,"duration":0,"updatedAt":"2026-11-03T12:00:00.000Z",
       "owner":"Sam","shared":true,"mine":false,
       "cover":{"url":"/art/playlist/5","layout":"ridges","variant":0,"frozen":true,"stale":false,"energy":0.5,"styles":[],
                "analyzed":0,"total":1,"pending":false},
       "items":[{"itemId":1,"recordingId":"rec-1","title":"Angel","artistName":"Massive Attack","albumTitle":"Mezzanine",
                 "addedAt":"2026-11-03T12:00:00.000Z"}]}
      """#
    let playlist = try APIClient.decode(PlaylistDetail.self, from: Data(json.utf8))
    #expect(playlist.collaborative == nil)
    #expect(playlist.canEdit == nil)
    #expect(playlist.items.first?.addedBy == nil)
  }
}
