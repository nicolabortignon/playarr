import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct LyricsModelTests {
  @Test func findsTheLineBeingSung() {
    // Ported from apps/web/src/components/LyricsView.test.tsx.
    let lines: [Double] = [5, 10, 20]
    #expect(LyricsModel.lineAt(lines, time: 1) == -1)
    #expect(LyricsModel.lineAt(lines, time: 10) == 1)
    #expect(LyricsModel.lineAt(lines, time: 99) == 2)
    // A line shows 0.15 s before it's sung.
    #expect(LyricsModel.lineAt(lines, time: 4.9) == 0)
    #expect(LyricsModel.lineAt([], time: 3) == -1)
  }

  @Test func loadsTimedLyrics() async {
    let model = LyricsModel(trackId: 700, session: demoSession())
    await model.load()
    #expect(model.state == .synced(Demo.lyrics.synced!, .lrclib))
  }

  @Test func saysWhenThereAreNone() async {
    let model = LyricsModel(trackId: 701, session: demoSession())
    await model.load()
    #expect(model.state == .none)
  }

  @Test func saysWhenTheyCantBeHad() async {
    let api = FakeAPI.demoLibrary()
    api.fail(.get, "/api/tracks/700/lyrics", status: 503, "LRCLIB is down")
    let model = LyricsModel(trackId: 700, session: demoSession(api: api))
    await model.load()
    #expect(model.state == .unavailable)
    // Asked twice: once, and the one retry.
    #expect(api.calls(.get, "/api/tracks/700/lyrics").count == 2)
  }

  @Test func knowsInstrumentalsAndPlainWords() {
    #expect(LyricsModel.state(Lyrics(instrumental: true, source: .file)) == .instrumental)
    #expect(LyricsModel.state(Lyrics(plain: "Words", source: .file)) == .plain("Words", .file))
  }

  @Test func stopsFollowingForFourSecondsAfterAScroll() {
    let model = LyricsModel(trackId: 700, session: demoSession())
    let now = Date()
    #expect(model.follows(at: now))
    model.touched(at: now)
    #expect(!model.follows(at: now.addingTimeInterval(3.9)))
    #expect(model.follows(at: now.addingTimeInterval(4)))
  }

  @Test func aLineTappedPlaysFromThere() {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks)
    LyricsModel(trackId: 700, session: session).seek(to: Demo.lyrics.synced![1])
    #expect(session.player.time == 12)
  }
}
