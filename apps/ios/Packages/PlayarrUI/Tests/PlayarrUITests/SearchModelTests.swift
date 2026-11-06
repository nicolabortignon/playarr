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

  @Test func anEmptySearchSaysWhatFollowsOrWhatToTry() async {
    // No Lidarr: nothing beyond the library to look in, so what to try, and New search.
    let alone = SearchModel.notFound("zzz", asksBeyond: false, beyond: nil)
    #expect(alone.line == PageLines.search("zzz"))
    #expect(alone.offersNewSearch)
    let api = FakeAPI()
    let beyond = DiscoverSearchModel(context: DiscoverContext(api: api, account: account(), clock: TestClock(), toast: { _, _ in }), clock: TestClock())
    // Lidarr's answer still to come: what's out there follows, so no New search yet.
    beyond.update("zzz")
    let waiting = SearchModel.notFound("zzz", asksBeyond: true, beyond: beyond)
    #expect(waiting.line == PageLines.search("zzz", beyond: true))
    #expect(!waiting.offersNewSearch)
    // Something out there: it follows.
    api.on(.get, "/api/discover/search", DiscoverSearchModelTests.answer)
    await beyond.reload()
    #expect(SearchModel.notFound("zzz", asksBeyond: true, beyond: beyond) == waiting)
    // Nothing anywhere: what to try.
    api.on(.get, "/api/discover/search", DiscoverResults(artists: [], albums: [], tracks: []))
    beyond.update("zzzz")
    await beyond.reload()
    let nowhere = SearchModel.notFound("zzzz", asksBeyond: true, beyond: beyond)
    #expect(nowhere.line == PageLines.search("zzzz", nothingAnywhere: true))
    #expect(nowhere.offersNewSearch)
    // Lidarr couldn't answer: as without it.
    api.fail(.get, "/api/discover/search", status: 502, "MusicBrainz didn’t answer")
    let failing = DiscoverSearchModel(context: DiscoverContext(api: api, account: account(), clock: TestClock(), toast: { _, _ in }), clock: TestClock())
    failing.update("air")
    await failing.reload()
    let unanswered = SearchModel.notFound("air", asksBeyond: true, beyond: failing)
    #expect(unanswered.line == PageLines.search("air"))
    #expect(unanswered.offersNewSearch)
  }

  @Test func suggestsTheArtistsWithTheMostMusic() async {
    let model = SearchModel(session: demoSession())
    await model.loadSuggestions()
    #expect(model.suggestions.map(\.name) == ["Massive Attack", "Portishead"])
    #expect(model.allArtistsLabel == nil)
  }
}
