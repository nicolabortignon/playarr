import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

/// The demo server remembers favorites and playlists, so the UI tests can change them.
@Suite struct DemoStateTests {
  @Test func heartsAndUnheartsASong() async throws {
    let api = DemoAPI()
    _ = try await api.send(API.Favorites.add(recordingId: "rec-700"))
    #expect(try await api.send(API.Favorites.list()).map(\.title) == ["Angel", "Risingson"])
    _ = try await api.send(API.Favorites.remove(recordingId: "rec-701"))
    #expect(try await api.send(API.Favorites.list()).map(\.title) == ["Angel"])
  }

  @Test func makesFillsReordersAndDeletesAPlaylist() async throws {
    let api = DemoAPI()
    let made = try await api.send(API.Playlists.create(name: "UI test"))
    #expect(made.id == 2)
    #expect(try await api.send(API.Playlists.list()).map(\.name) == ["UI test", "Late night"])
    _ = try await api.send(API.Playlists.addItems(id: 2, recordingIds: ["rec-700"]))
    let two = try await api.send(API.Playlists.addItems(id: 2, recordingIds: ["rec-701"]))
    #expect(two.items.map(\.title) == ["Angel", "Risingson"])
    #expect(two.trackCount == 2)
    let moved = try await api.send(API.Playlists.reorder(id: 2, itemIds: two.items.map(\.itemId).reversed()))
    #expect(moved.items.map(\.title) == ["Risingson", "Angel"])
    #expect(try await api.send(API.Playlists.recommendations(id: 2)).owned.map(\.title) == ["Inertia Creeps", "Protection"])
    _ = try await api.send(API.Playlists.delete(id: 2))
    await #expect(throws: APIError.server(status: 404, message: "Not found")) { try await api.send(API.Playlists.get(id: 2)) }
  }

  @Test func savesTheMixAsAPlaylist() async throws {
    let api = DemoAPI()
    let saved = try await api.send(API.Mixes.save(key: "vibes"))
    #expect(saved.name == "Your vibes · 3 Nov")
    #expect(saved.trackCount == 3)
    #expect(try await api.send(API.Stats.listening("2026")).months?.count == 12)
  }
}
