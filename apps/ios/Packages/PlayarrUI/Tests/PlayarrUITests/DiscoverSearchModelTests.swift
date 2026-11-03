import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct DiscoverSearchModelTests {
  let log = EventLog()

  nonisolated static let answer = DiscoverResults(
    artists: [
      DiscoverArtist(mbid: "a-1", name: "Massive Attack", genres: [], artistId: 7),
      DiscoverArtist(mbid: "a-2", name: "Mass Gothic", genres: ["indie"]),
    ],
    albums: [
      DiscoverAlbum(mbid: "rg-1", title: "Mezzanine", artistName: "Massive Attack", artistMbid: "a-1", type: "Album", secondaryTypes: [], availability: availability(.available, albumId: 70)),
      DiscoverAlbum(mbid: "rg-2", title: "Heligoland", artistName: "Massive Attack", artistMbid: "a-1", type: "Album", secondaryTypes: [], availability: availability(.noneValue)),
    ],
    tracks: (1...10).map { n in
      DiscoverTrack(id: "t-\(n)", title: "Song \(n)", artistName: "Massive Attack", albumTitle: "Heligoland", album: AlbumRef(mbid: "rg-2", artistName: "Massive Attack", albumTitle: "Heligoland"), availability: availability(.noneValue))
    })

  private func setUp() -> (DiscoverSearchModel, FakeAPI, TestClock) {
    let api = FakeAPI()
    api.on(.get, "/api/discover/search", Self.answer)
    let clock = TestClock()
    let context = DiscoverContext(api: api, account: account(), clock: TestClock(), toast: log.toast)
    return (DiscoverSearchModel(context: context, clock: clock), api, clock)
  }

  private func asked(_ api: FakeAPI) -> [String] { api.queries(.get, "/api/discover/search", "q") }

  @Test func asksOnce450MillisecondsAfterTheTypingStops() async {
    let (model, api, clock) = setUp()
    model.update("ma")
    #expect(await clock.nextSleep() == .milliseconds(450))
    model.update("mas")
    #expect(await clock.nextSleep() == .milliseconds(450))
    #expect(clock.sleeping == 1)
    #expect(model.loading)
    clock.advance(by: .milliseconds(450))
    await eventually { model.results != nil }
    #expect(asked(api) == ["mas"])
    #expect(!model.loading)
  }

  @Test func waitsForTwoCharacters() async {
    let (model, api, clock) = setUp()
    model.update("m")
    #expect(!model.loading)
    clock.advance(by: await clock.nextSleep())
    await eventually { model.answered == "m" }
    #expect(asked(api).isEmpty)
    #expect(model.results == nil)
  }

  @Test func leavesOutWhatIsAlreadyInTheLibrary() async {
    let (model, _, clock) = setUp()
    model.update("massive")
    clock.advance(by: await clock.nextSleep())
    await eventually { model.results != nil }
    #expect(model.albums.map(\.mbid) == ["rg-2"])
    #expect(model.artists.map(\.mbid) == ["a-2"])
    #expect(model.tracks.count == 8)
    #expect(!model.nothing)
  }

  @Test func keepsAnAnswerAMinute() async {
    let (model, api, _) = setUp()
    model.update("air")
    await model.reload()
    await model.reload()
    #expect(asked(api) == ["air"])
  }

  @Test func saysWhyDiscoverFailed() async {
    let (model, api, _) = setUp()
    api.fail(.get, "/api/discover/search", status: 502, "MusicBrainz didn’t answer")
    model.update("air")
    await model.reload()
    #expect(model.error == "MusicBrainz didn’t answer")
    #expect(model.results == nil)
  }
}

@Suite struct DiscoverDestinationTests {
  @Test func leadsToTheLibraryElseTheDiscographyElseALookup() {
    #expect(DiscoverDestination.artist(id: 7, mbid: "a-1", name: "Air") == .libraryArtist(id: 7))
    #expect(DiscoverDestination.artist(id: nil, mbid: "a-1", name: "Air") == .discoverArtist(mbid: "a-1", album: nil))
    #expect(DiscoverDestination.artist(id: nil, mbid: nil, name: "Air") == .findArtist(name: "Air", album: nil))
    #expect(DiscoverDestination.album(id: 70, artistMbid: "a-1", artistName: "Air", title: "Moon Safari") == .libraryAlbum(id: 70))
    #expect(DiscoverDestination.album(id: nil, artistMbid: "a-1", artistName: "Air", title: "Moon Safari") == .discoverArtist(mbid: "a-1", album: "Moon Safari"))
    #expect(DiscoverDestination.album(id: nil, artistMbid: nil, artistName: "Air", title: "Moon Safari") == .findArtist(name: "Air", album: "Moon Safari"))
  }

  @Test func opensAPartlyOwnedAlbumsPage() {
    func card(_ a: Availability) -> DiscoverDestination {
      .card(DiscoverAlbum(mbid: "rg", title: "T", artistName: "A", artistMbid: "a-1", type: "Album", secondaryTypes: [], availability: a))
    }
    #expect(card(availability(.available, albumId: 5)) == .libraryAlbum(id: 5))
    #expect(card(availability(.partial, albumId: 5, have: 2, total: 9)) == .libraryAlbum(id: 5))
    #expect(card(availability(.searching, albumId: 5, have: 2)) == .libraryAlbum(id: 5))
    #expect(card(availability(.noneValue)) == .discoverArtist(mbid: "a-1", album: nil))
  }

  @Test func followsALookedUpName() {
    #expect(DiscoverDestination.found(ArtistMatch(mbid: "a-1", artistId: 7), name: "Air", album: nil) == .libraryArtist(id: 7))
    #expect(DiscoverDestination.found(ArtistMatch(mbid: "a-1", artistId: 7), name: "Air", album: "Moon Safari") == .discoverArtist(mbid: "a-1", album: "Moon Safari"))
    #expect(DiscoverDestination.found(ArtistMatch(mbid: "a-1"), name: "Air", album: nil) == .discoverArtist(mbid: "a-1", album: nil))
  }

  @Test func opensTheLibrarysOwnPagesOnTheTabsStack() {
    #expect(DiscoverDestination.libraryArtist(id: 7).route == .artist(7))
    #expect(DiscoverDestination.libraryAlbum(id: 70).route == .album(70))
    #expect(DiscoverDestination.discoverArtist(mbid: "a-1", album: "Moon Safari").route == .discoverArtist(mbid: "a-1", album: "Moon Safari"))
    #expect(DiscoverDestination.findArtist(name: "Air", album: nil).route == .findArtist(name: "Air", album: nil))
    #expect(DiscoverDestination.requests.route == .requests)
  }
}
