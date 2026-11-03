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
    await recs.add(recs.owned[0])
    #expect(api.bodies(.post, "/api/playlists/5/items") == [#"{"recordingIds":["rec-800"]}"#])
    #expect(recs.owned.isEmpty)
    #expect(recs.empty)
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
