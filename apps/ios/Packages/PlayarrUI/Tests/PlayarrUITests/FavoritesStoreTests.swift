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

  /// Angel, favorited in March, then Risingson in January: newest first, Angel leads (FavoriteButton.test.tsx's).
  static let january = "2026-01-01T00:00:00.000Z"
  static let twoFavorites = [
    FavoriteTrack(Listening.angel, favoritedAt: "2026-03-01T00:00:00.000Z"), FavoriteTrack(Listening.risingson, favoritedAt: january),
  ]

  @Test func putsASongHeartedAgainBackWhereItWasNotAtTheTop() async {
    api.on(.get, "/api/favorites", Self.twoFavorites)
    api.on(.delete, "/api/favorites/rec-701", json: "")
    api.on(.put, "/api/favorites/rec-701", json: "")
    let favorites = store()
    await favorites.load()
    api.on(.get, "/api/favorites", [Self.twoFavorites[0]])
    await favorites.toggle(Listening.risingson)
    #expect(favorites.tracks?.map(\.title) == ["Angel"])
    api.on(.get, "/api/favorites", Self.twoFavorites)
    let gate = Gate()
    api.hold(.put, "/api/favorites/rec-701", until: gate)
    let hearting = Task { await favorites.toggle(Listening.risingson) }
    while api.calls(.put, "/api/favorites/rec-701").isEmpty { await Task.yield() }
    // At once, where it was: after Angel, favorited since.
    #expect(favorites.tracks?.map(\.title) == ["Angel", "Risingson"])
    #expect(api.bodies(.put, "/api/favorites/rec-701") == [#"{"favoritedAt":"2026-01-01T00:00:00.000Z"}"#])
    await gate.open()
    await hearting.value
    #expect(favorites.tracks?.map(\.title) == ["Angel", "Risingson"])
    // Away from Favorites, nothing in view went: no toast.
    #expect(toasts.toasts.isEmpty)
  }

  @Test func onFavoritesSaysTheSongWasRemovedWithUndoPuttingItBack() async throws {
    api.on(.get, "/api/favorites", Self.twoFavorites)
    api.on(.delete, "/api/favorites/rec-701", json: "")
    api.on(.put, "/api/favorites/rec-701", json: "")
    let favorites = store()
    await favorites.load()
    favorites.pagesShown = 1
    api.on(.get, "/api/favorites", [Self.twoFavorites[0]])
    await favorites.toggle(Listening.risingson)
    let toast = try #require(toasts.toasts.first)
    #expect(toast.message == "Removed “Risingson” from Favorites")
    #expect(toast.action?.label == "Undo")
    #expect(toast.removal)
    api.on(.get, "/api/favorites", Self.twoFavorites)
    toasts.perform(toast)
    while api.calls(.get, "/api/favorites").count < 3 { await Task.yield() }
    #expect(api.bodies(.put, "/api/favorites/rec-701") == [#"{"favoritedAt":"2026-01-01T00:00:00.000Z"}"#])
    #expect(favorites.tracks?.map(\.title) == ["Angel", "Risingson"])
    #expect(favorites.isFavorite("rec-701"))
  }

  @Test func heartsASongForTheFirstTimeAsOfNow() async {
    api.on(.get, "/api/favorites", Self.twoFavorites)
    api.on(.put, "/api/favorites/rec-703", json: "")
    let favorites = store()
    await favorites.load()
    favorites.pagesShown = 1
    api.on(.get, "/api/favorites", [FavoriteTrack(Listening.inertia, favoritedAt: "2026-11-07T10:00:00.000Z")] + Self.twoFavorites)
    await favorites.toggle(Listening.inertia)
    #expect(api.calls(.put, "/api/favorites/rec-703").map(\.body) == [nil])
    #expect(favorites.tracks?.first?.title == "Inertia Creeps")
    // Hearting takes nothing out: no toast, even on Favorites.
    #expect(toasts.toasts.isEmpty)
  }

  @Test func putsAFavoriteTakenBackBeforeTheFirstOneFavoritedBeforeIt() {
    let february = FavoriteTrack(Listening.inertia, favoritedAt: "2026-02-01T00:00:00.000Z")
    #expect(FavoritesStore.inPlace(february, in: Self.twoFavorites).map(\.title) == ["Angel", "Inertia Creeps", "Risingson"])
    let oldest = FavoriteTrack(Listening.inertia, favoritedAt: "2025-06-01T00:00:00.000Z")
    #expect(FavoritesStore.inPlace(oldest, in: Self.twoFavorites).last?.title == "Inertia Creeps")
  }

  @Test func opensWithTheFavoritesKeptLastTime() {
    let queries = QueryCache(directory: nil)
    queries.set([Demo.favorite], for: .favorites)
    let favorites = FavoritesStore(api: api, queries: queries, toasts: toasts)
    #expect(favorites.isFavorite("rec-701"))
    #expect(favorites.duration == 298)
  }
}
