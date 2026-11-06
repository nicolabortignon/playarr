import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct ArtistModelTests {
  func album(_ id: Int, type: String = "Album", secondary: [String] = []) -> Album {
    Album(id: id, title: "\(id)", artistId: 1, artistName: "", albumType: type, secondaryTypes: secondary, genres: [], duration: 0, trackCount: 1, totalTrackCount: 1)
  }

  @Test func groupsAlbumsAsTheWebDoes() {
    let groups = ArtistModel.groups([
      album(1), album(2, type: "EP"), album(3, secondary: ["Soundtrack"]), album(4, secondary: ["Live"]),
      album(5, type: "Single"), album(6, type: "Loose"), album(7, secondary: ["Compilation"]),
    ])
    #expect(groups.map(\.title) == ["Albums", "Soundtracks", "EPs & Singles", "Live & Compilations", "Loose songs"])
    #expect(groups.map { $0.albums.map(\.id) } == [[1], [3], [2, 5], [4, 7], [6]])
  }

  @Test func showsSimilarArtistsInTheLibrary() async {
    let model = ArtistModel(id: 7, session: demoSession())
    await model.load()
    #expect(model.similarInLibrary.map(\.name) == ["Portishead"])
    #expect(model.counts == "2 albums · 5 tracks")
    #expect(model.kicker == "trip hop")
  }

  @Test func playsEverySongOfTheArtistInOrder() async {
    let session = demoSession()
    let model = ArtistModel(id: 7, session: session)
    await model.play()
    #expect(session.player.queue.queue.map(\.artistName).allSatisfy { $0 == "Massive Attack" })
    #expect(session.player.queue.source == PlaySource(label: "Massive Attack", href: "/artists/7"))
    #expect(!session.player.queue.shuffle)
  }

  @Test func queuesEverySongOfTheArtistNextOrLast() async {
    let session = demoSession()
    session.player.play(Demo.dummyTracks)
    let model = ArtistModel(id: 7, session: session)
    await model.queue(next: true)
    await model.queue(next: false)
    let massive = Array(repeating: "Massive Attack", count: 5)
    #expect(session.player.queue.upcoming(20).map(\.artistName) == massive + ["Portishead", "Portishead"] + massive)
    #expect(session.player.queue.currentTrack?.title == "Mysterons")
    #expect(session.toasts.toasts.map(\.message) == ["Playing 5 tracks next", "Added 5 tracks to queue"])
  }

  @Test func playPausesAndResumesTheArtistsSongs() async {
    let session = demoSession()
    let model = ArtistModel(id: 7, session: session)
    #expect(model.playState == .stopped)
    await model.playOrPause()
    #expect(model.playState == .playing)
    await model.playOrPause()
    #expect(model.playState == .paused)
  }
}
