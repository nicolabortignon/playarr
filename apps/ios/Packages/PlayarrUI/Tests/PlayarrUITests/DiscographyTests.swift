import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct DiscographyTests {
  private func release(_ mbid: String, _ title: String, type: String = "Album", _ state: AvailabilityState = .noneValue) -> DiscoverAlbum {
    DiscoverAlbum(mbid: mbid, title: title, artistName: "Air", artistMbid: "a-1", type: type, secondaryTypes: [], availability: availability(state))
  }

  private var air: DiscoverArtistDetail {
    DiscoverArtistDetail(mbid: "a-1", name: "Air", genres: [], albums: [
      release("rg-1", "Moon Safari", .available), release("rg-2", "Talkie Walkie"),
      release("rg-3", "Premiers Symptômes", type: "EP", .partial), release("rg-4", "The Virgin Suicides", type: "Soundtrack"),
    ])
  }

  @Test func splitsAlbumsFromTheRestAndCountsWhatIsHere() {
    let d = Discography(air)
    #expect(d.groups.map(\.title) == ["Albums", "EPs & soundtracks"])
    #expect(d.groups.map { $0.albums.map(\.mbid) } == [["rg-1", "rg-2"], ["rg-3", "rg-4"]])
    #expect(d.groups[0].kicker == "2 releases")
    #expect(d.summary == "4 releases · 1 in your library")
    #expect(d.empty == nil)
  }

  @Test func highlightsTheAlbumASongLedTo() {
    #expect(Discography(air, wanted: "Talkie Walkie (Deluxe)").highlighted == "rg-2")
    let missing = Discography(air, wanted: "Kelly Watch the Stars")
    #expect(missing.highlighted == nil)
    #expect(missing.notice == "“Kelly Watch the Stars” isn’t among these albums and EPs; it’s probably a single or a compilation. You can still request it from the song.")
  }

  @Test func saysWhenMusicBrainzListsNothing() {
    let none = DiscoverArtistDetail(mbid: "a-1", name: "Air", genres: [], albums: [])
    #expect(Discography(none).empty == "MusicBrainz lists no albums or EPs for this artist.")
    #expect(Discography(none, wanted: "Moon Safari").notice == nil)
    let failed = DiscoverArtistDetail(mbid: "a-1", name: "Air", genres: [], albums: [], discographyError: "timeout")
    #expect(Discography(failed).empty == nil)
  }

  @Test func listsOnALibraryArtistOnlyWhatIsntHereAtAll() {
    let groups = Discography.notInLibrary(air, owned: [album(title: "Talkie Walkie", mbid: "rg-2")])
    #expect(groups.map(\.title) == ["EPs & soundtracks not in your library"])
    #expect(groups.flatMap(\.albums).map(\.mbid) == ["rg-4"])
  }

  @Test func groupsSimilarArtistsLibraryFirst() {
    let mine = DiscoverArtist(mbid: "a-2", name: "Daft Punk", genres: [], artistId: 3)
    let other = DiscoverArtist(mbid: "a-3", name: "Phoenix", genres: [])
    #expect(SimilarArtistGroups.make([other, mine]).map(\.title) == ["Similar artists in your library", "More similar artists"])
    #expect(SimilarArtistGroups.make([other]).map(\.title) == ["Similar artists"])
  }

  @Test func findsAnArtistByNameThenLeadsOn() async {
    let api = FakeAPI()
    api.on(.get, "/api/discover/artist-lookup", json: #"{"mbid":"a-1"}"#)
    let find = FindArtistModel(api: api, name: "Air", album: "Moon Safari")
    await find.load()
    #expect(find.destination == .discoverArtist(mbid: "a-1", album: "Moon Safari"))
    #expect(api.queries(.get, "/api/discover/artist-lookup", "name") == ["Air"])
    let nobody = FindArtistModel(api: api, name: "")
    await nobody.load()
    #expect(nobody.error == "No artist given.")
  }

  @Test func saysWhyALookupFailed() async {
    let api = FakeAPI()
    api.fail(.get, "/api/discover/artist-lookup", status: 404, "No artist called “Ayr” on MusicBrainz")
    let find = FindArtistModel(api: api, name: "Ayr")
    await find.load()
    #expect(find.error == "No artist called “Ayr” on MusicBrainz")
    #expect(find.destination == nil)
  }

  @Test func loadsADiscographyAgainOnTryAgain() async {
    let api = FakeAPI()
    api.fail(.get, "/api/discover/artists/a-1", status: 503, "MusicBrainz is busy")
    let context = DiscoverContext(api: api, account: account(), clock: TestClock(), toast: { _, _ in })
    let model = DiscoverArtistModel(context: context, mbid: "a-1", album: "Talkie Walkie")
    await model.load()
    #expect(model.error == "MusicBrainz is busy")
    api.on(.get, "/api/discover/artists/a-1", air)
    await model.load(again: true)
    #expect(model.error == nil)
    #expect(model.discography?.highlighted == "rg-2")
    #expect(context.generation(.discoverArtist) == 1)
  }
}
