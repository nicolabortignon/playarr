import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct PlaylistModelTests {
  let api = FakeAPI.demoLibrary()
  let three = Listening.three

  func model(_ playlist: PlaylistDetail, clock: any Clock<Duration> = ContinuousClock()) async -> (PlaylistModel, AccountSession) {
    api.on(.get, "/api/playlists/\(playlist.id)", playlist)
    api.on(.get, "/api/playlists", [Listening.summary(playlist)])
    let session = demoSession(api: api)
    let model = PlaylistModel(id: playlist.id, session: session, clock: clock)
    await model.load()
    return (model, session)
  }

  // MARK: Reordering

  @Test func movesTheWayOnMoveReportsADrop() {
    #expect(PlaylistModel.moved([1, 2, 3], fromOffsets: [2], toOffset: 0) == [3, 1, 2])
    #expect(PlaylistModel.moved([1, 2, 3], fromOffsets: [0], toOffset: 3) == [2, 3, 1])
    #expect(PlaylistModel.moved([1, 2, 3, 4], fromOffsets: [0, 2], toOffset: 4) == [2, 4, 1, 3])
    #expect(PlaylistModel.moved([1, 2, 3], fromOffsets: [1], toOffset: 1) == [1, 2, 3])
  }

  @Test func sendsTheNewOrderWhenASongIsDropped() async {
    let (model, _) = await model(Listening.playlist(items: three))
    api.on(.put, "/api/playlists/5/order", Listening.playlist(items: [three[2], three[0], three[1]]))
    await model.move(fromOffsets: [2], toOffset: 0)
    #expect(api.bodies(.put, "/api/playlists/5/order") == [#"{"itemIds":[3,1,2]}"#])
    #expect(model.items.map(\.itemId) == [3, 1, 2])
  }

  @Test func sendsNothingWhenTheOrderDidntChange() async {
    let (model, _) = await model(Listening.playlist(items: three))
    await model.move(fromOffsets: [1], toOffset: 2)
    #expect(api.calls(.put, "/api/playlists/5/order").isEmpty)
    #expect(model.items.map(\.itemId) == [1, 2, 3])
  }

  @Test func putsTheSongsBackWhenTheServerSaysNo() async {
    let (model, session) = await model(Listening.playlist(items: three))
    api.fail(.put, "/api/playlists/5/order", "Order must list every item in the playlist exactly once")
    await model.move(fromOffsets: [0], toOffset: 3)
    #expect(model.items.map(\.itemId) == [1, 2, 3])
    #expect(session.toasts.toasts.map(\.message) == ["Order must list every item in the playlist exactly once"])
  }

  // MARK: Whose it is

  @Test func offersNoWayToChangeSomeoneElsesSharedPlaylist() async {
    let (model, _) = await model(Listening.playlist(items: three, mine: false, shared: true, owner: "Sam"))
    #expect(model.sharing == "Shared by Sam")
    #expect(model.ownerActions.isEmpty)
    #expect(!model.canPickCover)
    #expect(model.own(at: 0).isEmpty)
    await model.move(fromOffsets: [2], toOffset: 0)
    await model.setShared(false)
    #expect(await model.save(name: "Mine now", description: ""))
    #expect(!(await model.delete()))
    #expect(!(await model.setCover(layout: .blocks, variant: 1)))
    #expect(api.calls.filter { $0.method != .get }.isEmpty)
    #expect(model.items.map(\.itemId) == [1, 2, 3])
  }

  @Test func letsTheOwnerShareAndStopSharing() async {
    let (model, _) = await model(Listening.playlist(items: three))
    #expect(model.sharing == nil)
    #expect(model.ownerActions == [.rename, .newCover, .share, .delete])
    api.on(.patch, "/api/playlists/5", Listening.playlist(items: three, shared: true))
    await model.setShared(true)
    #expect(api.bodies(.patch, "/api/playlists/5") == [#"{"shared":true}"#])
    #expect(model.sharing == "Shared with everyone")
    #expect(model.ownerActions == [.rename, .newCover, .stopSharing, .delete])
  }

  @Test func offersOnlyWhatAnEmptyOrUnavailablePlaylistCanDo() async {
    let (empty, _) = await model(Listening.playlist(items: []))
    #expect(empty.ownerActions == [.rename, .share, .delete])
    let (gone, _) = await model(Listening.playlist(6, items: [Listening.item(1, nil), Listening.item(2, Listening.risingson)]))
    #expect(gone.facts == "2 songs · 5 min · 1 not in library")
    // A song the library no longer has can still be moved and removed by the owner.
    #expect(gone.own(at: 0).map(\.title) == ["Move down", "Remove from playlist"])
  }

  // MARK: Changes

  @Test func renamesButAnEmptyNameCancels() async {
    let (model, _) = await model(Listening.playlist(items: three))
    #expect(await model.save(name: "  ", description: "x"))
    #expect(api.calls(.patch, "/api/playlists/5").isEmpty)
    api.on(.patch, "/api/playlists/5", Listening.playlist(5, "Night drive", items: three))
    #expect(await model.save(name: "Night drive", description: "Late"))
    #expect(api.bodies(.patch, "/api/playlists/5") == [#"{"description":"Late","name":"Night drive"}"#])
    #expect(model.playlist?.name == "Night drive")
  }

  @Test func removesASongAndDeletesThePlaylist() async {
    let (model, session) = await model(Listening.playlist(items: three))
    api.on(.delete, "/api/playlists/5/items/2", Listening.playlist(items: [three[0], three[2]]))
    await model.remove(three[1])
    #expect(model.items.map(\.itemId) == [1, 3])
    #expect(session.toasts.toasts.last?.message == "Removed “Risingson” from “Road trip”")
    #expect(session.toasts.toasts.last?.action?.label == "Undo")
    api.on(.delete, "/api/playlists/5", json: "")
    api.on(.get, "/api/playlists", json: "[]")
    #expect(await model.delete())
    #expect(api.calls(.delete, "/api/playlists/5").count == 1)
    #expect(session.playlists.playlists?.isEmpty == true)
  }

  @Test func theOwnerMovesASongUpOrDownAPlace() async {
    let (model, _) = await model(Listening.playlist(items: three))
    #expect(model.own(at: 0).map(\.kind) == [.moveDown, .remove])
    #expect(model.own(at: 1).map(\.kind) == [.moveUp, .moveDown, .remove])
    #expect(model.own(at: 2).map(\.kind) == [.moveUp, .remove])
    api.on(.put, "/api/playlists/5/order", Listening.playlist(items: [three[1], three[0], three[2]]))
    await model.move(1, to: 0)
    #expect(api.bodies(.put, "/api/playlists/5/order") == [#"{"itemIds":[2,1,3]}"#])
    api.on(.put, "/api/playlists/5/order", Listening.playlist(items: [three[1], three[2], three[0]]))
    await model.move(1, to: 2)
    #expect(api.bodies(.put, "/api/playlists/5/order").last == #"{"itemIds":[2,3,1]}"#)
    #expect(model.items.map(\.itemId) == [2, 3, 1])
  }

  @Test func undoPutsARemovedSongBackWhereItWas() async throws {
    let (model, session) = await model(Listening.playlist(items: three))
    api.on(.delete, "/api/playlists/5/items/2", Listening.playlist(items: [three[0], three[2]]))
    await model.remove(three[1])
    // The server adds it at the end as a new item; it's moved back after the song that came before it.
    api.on(.post, "/api/playlists/5/items", Listening.playlist(items: [three[0], three[2], Listening.item(4, Listening.risingson)]))
    api.on(.put, "/api/playlists/5/order", Listening.playlist(items: [three[0], Listening.item(4, Listening.risingson), three[2]]))
    session.toasts.perform(try #require(session.toasts.toasts.last))
    while api.calls(.put, "/api/playlists/5/order").isEmpty || model.items.count < 3 { await Task.yield() }
    #expect(api.bodies(.post, "/api/playlists/5/items") == [#"{"recordingIds":["rec-701"]}"#])
    #expect(api.bodies(.put, "/api/playlists/5/order") == [#"{"itemIds":[1,4,3]}"#])
    #expect(model.items.map(\.itemId) == [1, 4, 3])
  }

  @Test func aSongTheLibraryNoLongerHasGoesWithoutUndo() async {
    let (model, session) = await model(Listening.playlist(6, items: [Listening.item(1, nil), three[1]]))
    api.on(.delete, "/api/playlists/6/items/1", Listening.playlist(6, items: [three[1]]))
    await model.remove(model.items[0])
    #expect(session.toasts.toasts.last?.message == "Removed “Gone 1” from “Road trip”")
    #expect(session.toasts.toasts.last?.action == nil)
  }

  @Test func aRemovedSongComesBackWhenTheServerSaysNo() async {
    let (model, session) = await model(Listening.playlist(items: three))
    api.fail(.delete, "/api/playlists/5/items/2", status: 404, "Song not found in this playlist")
    await model.remove(three[1])
    #expect(model.items.map(\.itemId) == [1, 2, 3])
    #expect(session.toasts.toasts.map(\.message) == ["Song not found in this playlist"])
  }

  @Test func playsFromATappedSongSkippingTheUnavailable() async {
    let (model, session) = await model(Listening.playlist(items: [Listening.item(1, nil), three[1], three[2]]))
    model.play(from: model.items[2])
    #expect(session.player.queue.queue.map(\.title) == ["Risingson", "Inertia Creeps"])
    #expect(session.player.queue.currentTrack?.title == "Inertia Creeps")
    #expect(session.player.queue.source == PlaySource(label: "Road trip", href: "/playlists/5"))
    model.queue(next: true)
    #expect(session.toasts.toasts.map(\.message) == ["2 songs play next"])
  }

  @Test func playPausesAndResumesThePlaylistOnceItPlays() async {
    let (model, session) = await model(Listening.playlist(items: three))
    #expect(model.playState == .stopped)
    model.playOrPause()
    #expect(session.player.queue.currentTrack?.title == "Angel")
    #expect(model.playState == .playing)
    model.playOrPause()
    #expect(model.playState == .paused)
    model.playOrPause()
    #expect(model.playState == .playing)
  }

  @Test func stoppingSharingOffersUndoWhichSharesItAgain() async throws {
    let (model, session) = await model(Listening.playlist(items: three, shared: true))
    api.on(.patch, "/api/playlists/5", Listening.playlist(items: three, shared: false))
    await model.setShared(false)
    #expect(model.sharing == nil)
    let toast = try #require(session.toasts.toasts.first)
    #expect(toast.message == "Stopped sharing “Road trip”")
    #expect(toast.action?.label == "Undo")
    api.on(.patch, "/api/playlists/5", Listening.playlist(items: three, shared: true))
    session.toasts.perform(toast)
    await eventually { model.sharing != nil }
    #expect(model.sharing == "Shared with everyone")
    #expect(api.bodies(.patch, "/api/playlists/5") == [#"{"shared":false}"#, #"{"shared":true}"#])
  }

  @Test func sharingNeedsNoUndo() async {
    let (model, session) = await model(Listening.playlist(items: three))
    api.on(.patch, "/api/playlists/5", Listening.playlist(items: three, shared: true))
    await model.setShared(true)
    #expect(session.toasts.toasts.isEmpty)
  }

  @Test func askingToDeleteSaysWhatGoesAndWhatStays() {
    #expect(
      PlaylistView.deleteQuestion(Listening.playlist(items: three), songs: 3)
        == LossQuestion(title: "Delete “Road trip”?", message: "The playlist goes for good. Its 3 songs stay in your library.", verb: "Delete"))
    #expect(PlaylistView.deleteMessage(shared: false, songs: 2) == "The playlist goes for good. Its 2 songs stay in your library.")
    #expect(PlaylistView.deleteMessage(shared: false, songs: 1) == "The playlist goes for good. Its song stays in your library.")
    #expect(
      PlaylistView.deleteMessage(shared: true, songs: 0) == "The playlist goes for good, for everyone it’s shared with.")
  }

  @Test func pollsEveryFourSecondsWhileTheCoverIsDrawn() async {
    let clock = TestClock()
    let (model, _) = await model(Listening.playlist(pending: true), clock: clock)
    api.then(.get, "/api/playlists/5", Listening.playlist(pending: false))
    let polling = Task { await model.poll() }
    #expect(await clock.nextSleep() == .seconds(4))
    clock.advance(by: .seconds(4))
    await polling.value
    #expect(model.playlist?.cover.pending == false)
  }
}
