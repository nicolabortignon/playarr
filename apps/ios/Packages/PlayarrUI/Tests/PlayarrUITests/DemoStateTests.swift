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

  @Test func putsASongHeartedAgainBackWhereItWas() async throws {
    let api = DemoAPI()
    _ = try await api.send(API.Favorites.add(recordingId: "rec-700"))
    // Inertia Creeps, first favorited before Risingson (1 November), goes back after it.
    _ = try await api.send(API.Favorites.add(recordingId: "rec-703", favoritedAt: "2026-10-01T00:00:00.000Z"))
    #expect(try await api.send(API.Favorites.list()).map(\.title) == ["Angel", "Risingson", "Inertia Creeps"])
  }

  @Test func suggestsSongsLikeTheFavoritesNotHeartedYet() async throws {
    let api = DemoAPI()
    _ = try await api.send(API.Favorites.add(recordingId: "rec-700"))
    let recommendations = try await api.send(API.Favorites.recommendations())
    #expect(recommendations.owned.map(\.title) == ["Inertia Creeps", "Protection"])
    #expect(recommendations.owned.map(\.because) == ["Angel", "Angel"])
    _ = try await api.send(API.Favorites.remove(recordingId: "rec-700"))
    _ = try await api.send(API.Favorites.remove(recordingId: "rec-701"))
    #expect(try await api.send(API.Favorites.recommendations()).seedCount == 0)
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

  @Test func letsEveryoneAddToAPlaylistOnlyOnceItsShared() async throws {
    let api = DemoAPI()
    await #expect(throws: APIError.server(status: 400, message: "Only a shared playlist can take songs from others")) {
      try await api.send(API.Playlists.update(id: 1, collaborative: true))
    }
    let open = try await api.send(API.Playlists.update(id: 1, shared: true, collaborative: true))
    #expect(open.collaborative == true)
    #expect(try await api.send(API.Playlists.list()).first?.collaborative == true)
    // Stopping sharing stops it too.
    #expect(try await api.send(API.Playlists.update(id: 1, shared: false)).collaborative == false)
  }

  @Test func addsToSomeoneElsesCollaborativePlaylistButChangesNothingElseOfIt() async throws {
    let api = DemoAPI(state: DemoState(collaborative: true))
    let kitchen = try #require(try await api.send(API.Playlists.list()).first { $0.name == "Sunday kitchen" })
    #expect(kitchen.mine == false)
    #expect(kitchen.canEdit == true)
    #expect(try await api.send(API.Playlists.get(id: kitchen.id)).items.map(\.addedBy) == [nil, "Sam", nil])
    let added = try await api.send(API.Playlists.addItems(id: kitchen.id, recordingIds: ["rec-700"]))
    #expect(added.items.map(\.title) == ["Protection", "Sour Times", "Karmacoma", "Angel"])
    // The demo account added Angel: it says nothing of whose it is to them.
    #expect(added.items.last?.addedBy == nil)
    #expect(try await api.send(API.Playlists.holding(recordingIds: ["rec-700"])).count(kitchen.id) == 1)
    await #expect(throws: APIError.server(status: 403, message: "Only its owner can change this playlist")) {
      try await api.send(API.Playlists.update(id: kitchen.id, name: "Mine now"))
    }
    await #expect(throws: APIError.server(status: 403, message: "Only its owner can change this playlist")) {
      try await api.send(API.Playlists.delete(id: kitchen.id))
    }
  }

  @Test func savesTheMixAsAPlaylist() async throws {
    let api = DemoAPI()
    let saved = try await api.send(API.Mixes.save(key: "vibes"))
    #expect(saved.name == "Your vibes · 3 Nov")
    #expect(saved.trackCount == 3)
    #expect(try await api.send(API.Stats.listening("2026")).months?.count == 12)
  }
}
