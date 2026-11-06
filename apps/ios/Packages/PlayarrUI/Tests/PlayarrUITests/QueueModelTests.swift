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

  @Test func movesASongUpAndDownAPlace() {
    let (_, model) = playing()
    model.move(1, to: 2)
    #expect(model.upcoming.map(\.track.title) == ["Risingson", "Protection", "Inertia Creeps", "Karmacoma"])
    model.move(1, to: 0)
    #expect(model.upcoming.map(\.track.title) == ["Protection", "Risingson", "Inertia Creeps", "Karmacoma"])
    // Past either end: nothing moves.
    model.move(0, to: -1)
    model.move(3, to: 4)
    #expect(model.upcoming.map(\.track.title) == ["Protection", "Risingson", "Inertia Creeps", "Karmacoma"])
  }

  @Test func removesWithUndoPuttingTheSongBackInItsPlace() throws {
    let (session, model) = playing()
    model.remove(1)
    #expect(model.upcoming.map(\.track.title) == ["Risingson", "Protection", "Karmacoma"])
    let undo = try #require(session.toasts.toasts.last)
    #expect(undo.message == "Removed “Inertia Creeps” from the queue")
    // The song after it moved since: the song goes back before it all the same.
    model.move(1, to: 2)
    session.toasts.perform(undo)
    #expect(model.upcoming.map(\.track.title) == ["Risingson", "Karmacoma", "Inertia Creeps", "Protection"])
  }

  @Test func removesSeveralAtOnceWithoutUndo() {
    let (session, model) = playing()
    model.remove([0, 2])
    #expect(model.upcoming.map(\.track.title) == ["Inertia Creeps", "Karmacoma"])
    #expect(session.toasts.toasts.isEmpty)
    model.play(1)
    #expect(model.current?.title == "Karmacoma")
  }

  @Test func playNextMovesASongUpWithUndo() throws {
    let (session, model) = playing()
    model.playNext(2)
    #expect(model.upcoming.map(\.track.title) == ["Protection", "Risingson", "Inertia Creeps", "Karmacoma"])
    let undo = try #require(session.toasts.toasts.last)
    #expect(undo.message == "“Protection” plays next")
    session.toasts.perform(undo)
    #expect(model.upcoming.map(\.track.title) == ["Risingson", "Inertia Creeps", "Protection", "Karmacoma"])
  }

  @Test func clearsWithUndo() throws {
    let (session, model) = playing()
    model.clear()
    #expect(model.upcoming.isEmpty)
    let toast = try #require(session.toasts.toasts.last)
    #expect(toast.message == "Cleared 4 songs from the queue")
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
