import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct RecommendationsModelTests {
  let api = FakeAPI.demoLibrary()

  func recommendation(_ track: Track?, _ title: String) -> RecommendedTrack {
    RecommendedTrack(
      recordingId: track?.recordingId ?? "rec-\(title)", title: title, artistName: "Portishead", albumTitle: "Dummy", because: "Angel",
      track: track, album: track == nil ? AlbumRef(artistName: "Portishead", albumTitle: "Third") : nil)
  }

  func model() async -> RecommendationsModel {
    let playlist = Listening.playlist(items: [Listening.three[0]])
    api.on(.get, "/api/playlists/5", playlist)
    api.on(.get, "/api/playlists", [Listening.summary(playlist)])
    let model = PlaylistModel(id: 5, session: demoSession(api: api))
    await model.load()
    return RecommendationsModel(playlist: model)
  }

  @Test func addsASongYouHaveAndTakesItOffTheList() async {
    let mysterons = Demo.dummyTracks[0]
    api.on(.get, "/api/playlists/5/recommendations", Recommendations(owned: [recommendation(mysterons, "Mysterons")], missing: [], seedCount: 1))
    api.on(.post, "/api/playlists/5/items", Listening.playlist(items: [Listening.three[0], Listening.item(4, mysterons)]))
    let recs = await model()
    await recs.load()
    #expect(recs.addLabel(recs.owned[0]) == "Add Mysterons to playlist")
    await recs.add(recs.owned[0])
    #expect(api.bodies(.post, "/api/playlists/5/items") == [#"{"recordingIds":["rec-800"]}"#])
    #expect(recs.owned.isEmpty)
    #expect(recs.empty)
    #expect(recs.emptyLine.hasSuffix("Try other suggestions, or add a few more songs."))
  }

  @Test func heartsASongYouHaveUnderFavoritesAndTakesItOffTheList() async {
    let mysterons = Demo.dummyTracks[0]
    api.on(.get, "/api/favorites/recommendations", Recommendations(owned: [recommendation(mysterons, "Mysterons")], missing: [], seedCount: 1))
    api.on(.put, "/api/favorites/rec-800", json: "")
    let session = demoSession(api: api)
    let recs = RecommendationsModel(favoritesOf: session)
    await recs.load()
    #expect(recs.addLabel(recs.owned[0]) == "Add Mysterons to Favorites")
    api.on(.get, "/api/favorites", [FavoriteTrack(mysterons, favoritedAt: "2026-11-07T10:00:00.000Z"), Demo.favorite])
    await recs.add(recs.owned[0])
    #expect(api.calls(.put, "/api/favorites/rec-800").count == 1)
    #expect(session.favorites.isFavorite("rec-800"))
    #expect(recs.owned.isEmpty)
    #expect(recs.emptyLine.hasSuffix("Try other suggestions, or heart a few more songs."))
    #expect(session.toasts.toasts.map(\.message) == ["Added “Mysterons” to Favorites"])
  }

  @Test func leavesOutASongHeartedMeanwhileAndAsksFavoritesForAnotherSet() async {
    let risingson = Demo.mezzanineTracks[1]
    api.on(
      .get, "/api/favorites/recommendations",
      Recommendations(owned: [recommendation(risingson, "Risingson"), recommendation(Demo.dummyTracks[0], "Mysterons")], missing: [], seedCount: 2))
    let session = demoSession(api: api)
    // Risingson is the demo's favorite: hearted since the set came, with the player's heart say.
    await session.favorites.load()
    let recs = RecommendationsModel(favoritesOf: session)
    await recs.newMix()
    #expect(api.queries(.get, "/api/favorites/recommendations", "variant") == ["1"])
    #expect(recs.owned.map(\.title) == ["Mysterons"])
  }

  @Test func showsEightMissingSongsUntilAskedForAll() async {
    let missing = (1...14).map { recommendation(nil, "Missing \($0)") }
    api.on(.get, "/api/playlists/5/recommendations", Recommendations(owned: [], missing: missing, seedCount: 3))
    let recs = await model()
    await recs.load()
    #expect(recs.shownMissing.count == 8)
    #expect(recs.moreLabel == "Show all 14")
    recs.showAll = true
    #expect(recs.shownMissing.count == 14)
    #expect(recs.moreLabel == "Show fewer")
  }

  @Test func asksForAnotherSetAndHidesWithoutSeeds() async {
    api.on(.get, "/api/playlists/5/recommendations", Recommendations(owned: [], missing: [], seedCount: 0))
    let recs = await model()
    await recs.newMix()
    #expect(api.queries(.get, "/api/playlists/5/recommendations", "variant") == ["1"])
    #expect(recs.hidden)
  }

  @Test func linksItsArtistAndAlbumAsTheWebDoes() {
    var heard = recommendation(nil, "Roads")
    heard.artistMbid = "mb-portishead"
    #expect(RecommendationsModel.artist(heard) == .discoverArtist(mbid: "mb-portishead", album: nil))
    #expect(RecommendationsModel.album(heard) == .discoverArtist(mbid: "mb-portishead", album: "Dummy"))
    heard.availability = Availability(state: .partial, albumId: 3, have: 2, total: 11)
    #expect(RecommendationsModel.album(heard) == .libraryAlbum(id: 3))
    heard.availability = Availability(state: .downloading, albumId: 3)
    #expect(RecommendationsModel.album(heard) == .discoverArtist(mbid: "mb-portishead", album: "Dummy"))
    let owned = recommendation(Demo.dummyTracks[0], "Mysterons")
    #expect(RecommendationsModel.album(owned) == .libraryAlbum(id: Demo.dummyTracks[0].albumId))
    #expect(RecommendationsModel.artist(RecommendedTrack(recordingId: "r", title: "t", artistName: "Tricky", albumTitle: "", because: "")) == .findArtist(name: "Tricky", album: nil))
  }
}
