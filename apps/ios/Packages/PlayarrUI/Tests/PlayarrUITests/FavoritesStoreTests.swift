import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct FavoritesStoreTests {
  let api = FakeAPI()
  let toasts = ToastCenter(clock: TestClock())

  func store() -> FavoritesStore { FavoritesStore(api: api, queries: QueryCache(directory: nil), toasts: toasts) }

  @Test func heartsASongAtOnceAndKeepsWhatTheServerSays() async {
    api.on(.get, "/api/favorites", [Demo.favorite])
    let favorites = store()
    await favorites.load()
    let gate = Gate()
    api.hold(.put, "/api/favorites/rec-700", until: gate)
    api.on(.put, "/api/favorites/rec-700", json: "")
    let toggling = Task { await favorites.toggle(Listening.angel) }
    while api.calls(.put, "/api/favorites/rec-700").isEmpty { await Task.yield() }
    #expect(favorites.isFavorite("rec-700"))
    #expect(favorites.tracks?.map(\.title) == ["Angel", "Risingson"])
    api.on(.get, "/api/favorites", [FavoriteTrack(Listening.angel, favoritedAt: "2026-11-03T10:00:00.000Z"), Demo.favorite])
    await gate.open()
    await toggling.value
    #expect(api.calls(.get, "/api/favorites").count == 2)
    #expect(favorites.tracks?.map(\.title) == ["Angel", "Risingson"])
  }

  @Test func putsTheHeartBackWhenTheServerSaysNo() async {
    api.on(.get, "/api/favorites", [Demo.favorite])
    let favorites = store()
    await favorites.load()
    api.fail(.delete, "/api/favorites/rec-701", status: 404, "Song not found in the library")
    await favorites.toggle(Listening.risingson)
    #expect(favorites.isFavorite("rec-701"))
    #expect(favorites.tracks?.map(\.title) == ["Risingson"])
    #expect(toasts.toasts.map(\.message) == ["Couldn’t update Favorites: Song not found in the library"])
    #expect(toasts.toasts.map(\.tone) == [.error])
  }

  @Test func aListAskedForBeforeAToggleDoesntUndoIt() async {
    let gate = Gate()
    api.on(.get, "/api/favorites", json: "[]")
    api.on(.put, "/api/favorites/rec-703", json: "")
    api.hold(.get, "/api/favorites", until: gate)
    let favorites = store()
    let loading = Task { await favorites.load() }
    while api.calls(.get, "/api/favorites").isEmpty { await Task.yield() }
    // Only that first list is held: the one asked for after the toggle answers at once.
    let free = Gate()
    await free.open()
    api.hold(.get, "/api/favorites", until: free)
    api.on(.get, "/api/favorites", [FavoriteTrack(Listening.inertia, favoritedAt: "2026-11-03T10:00:00.000Z")])
    await favorites.toggle(Listening.inertia)
    await gate.open()
    await loading.value
    #expect(favorites.isFavorite("rec-703"))
  }

  @Test func opensWithTheFavoritesKeptLastTime() {
    let queries = QueryCache(directory: nil)
    queries.set([Demo.favorite], for: .favorites)
    let favorites = FavoritesStore(api: api, queries: queries, toasts: toasts)
    #expect(favorites.isFavorite("rec-701"))
    #expect(favorites.duration == 298)
  }
}
