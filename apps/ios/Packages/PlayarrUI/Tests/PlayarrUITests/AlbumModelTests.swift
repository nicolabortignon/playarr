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
    #expect(model.kicker == "Album · 1998")
    #expect(model.details(now: Format.parseDate("2026-11-04T12:00:00Z")!) == "3 tracks · 17 min · 2 missing · added 3 days ago")
    #expect(model.moreByArtist.map(\.title) == ["Protection"])
  }

  @Test func playsPausesAndResumes() async {
    let session = demoSession()
    let model = AlbumModel(id: 70, session: session)
    await model.load()
    #expect(model.playLabel == "Play")
    model.playOrPause()
    #expect(session.player.queue.source == PlaySource(label: "Mezzanine", href: "/albums/70"))
    #expect(model.playLabel == "Pause")
    model.playOrPause()
    #expect(model.playLabel == "Resume")
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
