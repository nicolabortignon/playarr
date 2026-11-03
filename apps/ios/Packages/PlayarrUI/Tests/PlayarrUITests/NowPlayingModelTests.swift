import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct NowPlayingModelTests {
  @Test func closesAtTheWebsThresholds() {
    #expect(!NowPlayingModel.closes(translation: 120, velocity: 600))
    #expect(NowPlayingModel.closes(translation: 121, velocity: 0))
    #expect(NowPlayingModel.closes(translation: 10, velocity: 601))
  }

  @Test func saysWhereTheMusicIsFrom() {
    let session = demoSession()
    let model = NowPlayingModel(session: session)
    session.player.play(Demo.mezzanineTracks)
    #expect(model.playingFrom == "Mezzanine")
    #expect(model.playingFromRoute == .album(70))
    session.player.play(Demo.dummyTracks, source: PlaySource(label: "Your whole library", href: "/albums"))
    #expect(model.playingFrom == "Your whole library")
    #expect(model.playingFromRoute == .albums(.artist))
    #expect(model.repeatLabel == "Repeat: off")
  }

  @Test func namesTheSleepTimersChoices() {
    #expect(NowPlayingModel.sleepMinutes.map(NowPlayingModel.sleepLabel) == ["In 15 minutes", "In 30 minutes", "In 45 minutes", "In an hour", "In 1.5 hours"])
  }
}
