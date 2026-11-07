import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct HomeModelTests {
  @Test func showsTheYearInReviewInDecemberAndJanuary() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let date = { (iso: String) in Format.parseDate(iso)! }
    #expect(HomeModel.reviewYear(now: date("2026-12-03T12:00:00Z"), calendar: calendar) == 2026)
    #expect(HomeModel.reviewYear(now: date("2027-01-20T12:00:00Z"), calendar: calendar) == 2026)
    #expect(HomeModel.reviewYear(now: date("2026-11-03T12:00:00Z"), calendar: calendar) == nil)
  }

  @Test func showsTheArtistsOfTheLatestAlbumsFirstThenTheBiggest() {
    // Ported from apps/web/src/pages/Home.test.ts.
    let artists = (0..<300).map { i in Artist(id: i, name: "\(i)", sortName: "\(i)", genres: [], albumCount: i % 7, trackCount: 1) }
    let recent = [250, 3, 250].map { id in Album(id: id, title: "", artistId: id, artistName: "", albumType: "Album", secondaryTypes: [], genres: [], duration: 0, trackCount: 1, totalTrackCount: 1) }
    let shelf = HomeModel.shelfArtists(artists, recent: recent)
    #expect(shelf.count == 20)
    #expect(shelf.prefix(2).map(\.id) == [250, 3])
    #expect(shelf.dropFirst(2).allSatisfy { $0.albumCount == 6 })
  }

  @Test func saysHowBigTheLibraryIs() async {
    let model = HomeModel(session: demoSession())
    await model.load()
    #expect(model.libraryLine == "8 songs across 3 albums, 45 min of music waiting in your library.")
    #expect(model.jumpBackIn.count == 3)
    #expect(model.favoriteTracks.map(\.title) == ["Risingson"])
    #expect(model.showsMixes)
  }

  @Test func hidesJumpBackInUntilThreeAlbums() async {
    let api = FakeAPI.demoLibrary()
    api.on(.get, "/api/plays/recent-albums", Array(Demo.albums.prefix(2)))
    let model = HomeModel(session: demoSession(api: api))
    await model.load()
    #expect(model.jumpBackIn.isEmpty)
  }

  @Test func hidesTheYearInReviewOfAnotherYear() async {
    let api = FakeAPI.demoLibrary()
    let stats = ListeningStats(range: "2025", to: "2025-12-31", minutes: 600, plays: 12, songs: 3, artists: 1, days: 2, newArtists: 0, longestStreak: 1, topArtists: [.init(artist: Demo.artist, plays: 12, minutes: 600)], topAlbums: [], topTracks: [], topGenres: [], hours: [], weekdays: [], years: [2026])
    api.on(.get, "/api/stats", stats)
    let december = Format.parseDate("2026-12-03T12:00:00Z")!
    let model = HomeModel(session: demoSession(api: api), now: december)
    await model.load()
    #expect(model.yearInReview == nil)
  }

  @Test func playsWhatFeelingLuckyPutsTogetherInItsOrder() async {
    let session = demoSession()
    let model = HomeModel(session: session)
    await model.feelingLucky()
    #expect(!session.player.queue.shuffle)
    #expect(session.player.queue.queue.map(\.id) == Demo.tracks.map(\.id))
    #expect(session.player.queue.source == PlaySource(label: "Feeling lucky · Evening: warm", href: "/"))
  }

  @Test func offersTheSongOfTheSessionToPauseAndResume() {
    let session = demoSession()
    let model = HomeModel(session: session)
    #expect(model.listening == nil)
    session.player.play(Demo.mezzanineTracks)
    session.player.setPlaying(false)
    #expect(model.listening?.title == "Angel")
    #expect(!model.isPlaying)
    // Playing, it stays: drawn in to its cover with a pause sign.
    model.togglePlay()
    #expect(model.listening?.title == "Angel")
    #expect(model.isPlaying)
    model.togglePlay()
    #expect(!model.isPlaying)
  }

  @Test func saysWhatComesNextWhileTheMiniPlayerShows() {
    let session = demoSession()
    let model = HomeModel(session: session)
    #expect(!model.miniPlayerShows)
    session.player.play(Demo.mezzanineTracks)
    // The phone's tabs: the mini player has play and pause, so Home says what's next.
    #expect(model.miniPlayerShows)
    #expect(model.upNext?.title == "Risingson")
    session.player.jump(to: 2)
    #expect(model.upNext == nil)
    // The iPad's sidebar: no mini player, so the play and pause button stays.
    session.router.setLayout(.split)
    #expect(!model.miniPlayerShows)
  }

  @Test func rollsTheDiceForOtherAlbums() async {
    let api = FakeAPI.demoLibrary()
    let model = HomeModel(session: demoSession(api: api))
    await model.load()
    await model.reshuffle()
    #expect(model.seed == 1)
    #expect(api.calls(.get, "/api/albums/random").count == 2)
  }
}

@MainActor @Suite struct HomeFailureTests {
  @Test func saysSoWhenNothingCanBeLoaded() async {
    let model = HomeModel(session: demoSession(api: FakeAPI()))
    await model.load()
    #expect(model.failure != nil)
  }

  @Test func showsTheLibraryWhenItLoads() async {
    let model = HomeModel(session: demoSession())
    await model.load()
    #expect(model.failure == nil)
  }
}
