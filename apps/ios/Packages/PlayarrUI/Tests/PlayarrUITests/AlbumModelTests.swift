import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct AlbumModelTests {
  @Test func putsMissingSongsInTheirPlace() {
    let rows = AlbumModel.rows(Demo.mezzanine)
    let titles = rows.map { row -> String in
      switch row {
      case .disc(let n): "Disc \(n)"
      case .track(let track, _): track.title
      case .missing(let missing): "(\(missing.title))"
      }
    }
    #expect(titles == ["Angel", "Risingson", "(Teardrop)", "Inertia Creeps", "(Exchange)"])
  }

  @Test func headsEachDiscWhenThereAreSeveral() {
    let rows = AlbumModel.rows(Demo.dummy)
    #expect(rows.first == .disc(1))
    #expect(rows.filter { if case .disc = $0 { true } else { false } } == [.disc(1), .disc(2)])
    #expect(AlbumModel.rows(Demo.protection).allSatisfy { if case .disc = $0 { false } else { true } })
  }

  @Test func describesTheAlbum() async {
    let model = AlbumModel(id: 70, session: demoSession())
    await model.load()
    #expect(model.kicker == "Album")
    // Missing songs are greyed in the list and how long ago it came isn't said: the line stays one short line.
    #expect(model.facts == "1998 · 3 songs · 17 min")
    #expect(model.artistPhoto == "/art/artist/7/poster")
    #expect(model.moreByArtist.map(\.title) == ["Protection"])
  }

  @Test func theMetaLineLeavesOutAYearItDoesntKnow() {
    var album = Demo.protection
    #expect(AlbumModel.facts(album) == "1994 · 2 songs · 13 min")
    album.year = nil
    album.trackCount = 1
    #expect(AlbumModel.facts(album) == "1 song · 13 min")
  }

  @Test func theKickerSaysWhatKindOfReleaseItIs() async {
    var live = Demo.mezzanine
    live.secondaryTypes = ["Live"]
    let api = FakeAPI.demoLibrary()
    api.on(.get, "/api/albums/70", live)
    let model = AlbumModel(id: 70, session: demoSession(api: api))
    await model.load()
    #expect(model.kicker == "Live album")
  }

  @Test func playsPausesAndResumes() async {
    let session = demoSession()
    let model = AlbumModel(id: 70, session: session)
    await model.load()
    #expect(model.playState == .stopped)
    model.playOrPause()
    #expect(session.player.queue.source == PlaySource(label: "Mezzanine", href: "/albums/70"))
    #expect(model.playState == .playing)
    model.playOrPause()
    #expect(model.playState == .paused)
  }

  @Test func aSongTappedPlaysTheAlbumFromThere() async {
    let session = demoSession()
    let model = AlbumModel(id: 70, session: session)
    await model.load()
    model.tap(Demo.mezzanineTracks[1], index: 1)
    #expect(session.player.queue.currentTrack?.title == "Risingson")
    #expect(session.player.queue.queue.count == 3)
    model.shuffle()
    #expect(session.player.queue.shuffle)
  }
}
