import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct QueueModelTests {
  func playing() -> (AccountSession, QueueModel) {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks + Demo.protectionTracks)
    return (session, QueueModel(session: session))
  }

  @Test func listsWhatComesNext() {
    let (_, model) = playing()
    #expect(model.current?.title == "Angel")
    #expect(model.upcoming.map(\.track.title) == ["Risingson", "Inertia Creeps", "Protection", "Karmacoma"])
    #expect(model.header == "Up next · 4 songs · 24 min")
  }

  @Test func dragsASongToAnotherPlace() {
    let (_, model) = playing()
    model.move(from: [3], to: 0)
    #expect(model.upcoming.map(\.track.title) == ["Karmacoma", "Risingson", "Inertia Creeps", "Protection"])
  }

  @Test func removesAndPlaysNext() {
    let (_, model) = playing()
    model.remove([0, 2])
    #expect(model.upcoming.map(\.track.title) == ["Inertia Creeps", "Karmacoma"])
    model.playNext(model.upcoming[1])
    #expect(model.upcoming.map(\.track.title) == ["Karmacoma", "Inertia Creeps"])
    model.play(1)
    #expect(model.current?.title == "Inertia Creeps")
  }

  @Test func clearsWithUndo() throws {
    let (session, model) = playing()
    model.clear()
    #expect(model.upcoming.isEmpty)
    let toast = try #require(session.toasts.toasts.last)
    #expect(toast.message == "Cleared 4 songs")
    session.toasts.perform(toast)
    #expect(model.upcoming.map(\.track.title) == ["Risingson", "Inertia Creeps", "Protection", "Karmacoma"])
  }

  @Test func undoDoesNothingOnceAnotherSongPlays() throws {
    let (session, model) = playing()
    model.clear()
    session.player.play(Demo.dummyTracks)
    session.toasts.perform(try #require(session.toasts.toasts.last))
    #expect(model.upcoming.map(\.track.title) == ["Sour Times", "Glory Box"])
  }
}
