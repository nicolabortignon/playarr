import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct SearchModelTests {
  @Test func findsSongsAlbumsAndArtists() async {
    let api = FakeAPI.demoLibrary()
    api.on(.get, "/api/search", Demo.search("massive"))
    let model = SearchModel(session: demoSession(api: api))
    model.text = " massive "
    await model.search()
    #expect(model.topArtist?.name == "Massive Attack")
    #expect(model.tracks.count == 5)
    #expect(model.results?.albums.map(\.title) == ["Mezzanine", "Protection"])
    #expect(!model.isEmpty)
  }

  @Test func showsSixSongsThenAll() async {
    let api = FakeAPI.demoLibrary()
    let many = (0..<14).map { i in Demo.tracks[i % Demo.tracks.count] }
    api.on(.get, "/api/search", SearchResults(artists: [], albums: [], tracks: many))
    let model = SearchModel(session: demoSession(api: api))
    model.text = "a"
    await model.search()
    #expect(model.tracks.count == 6)
    #expect(model.showAllLabel == "Show all 14 songs")
    model.showAllTracks = true
    #expect(model.tracks.count == 14)
    #expect(model.showAllLabel == nil)
  }

  @Test func matchesPlaylistNamesWithoutAccents() async {
    let api = FakeAPI.demoLibrary()
    var café = Demo.playlist
    café.name = "Café del Mar"
    api.on(.get, "/api/playlists", [café, Demo.playlist])
    let model = SearchModel(session: demoSession(api: api))
    await model.loadSuggestions()
    model.text = "CAFE"
    await model.search()
    #expect(model.playlistHits.map(\.name) == ["Café del Mar"])
  }

  @Test func saysWhenNothingMatches() async {
    let api = FakeAPI.demoLibrary()
    api.on(.get, "/api/search", Demo.search("zzz"))
    let model = SearchModel(session: demoSession(api: api))
    model.text = "zzz"
    await model.search()
    #expect(model.isEmpty)
  }

  @Test func suggestsTheArtistsWithTheMostMusic() async {
    let model = SearchModel(session: demoSession())
    await model.loadSuggestions()
    #expect(model.suggestions.map(\.name) == ["Massive Attack", "Portishead"])
    #expect(model.allArtistsLabel == nil)
  }
}
