import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct TrackActionsTests {
  @Test func queuesSongsAndNamesThem() {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks)
    session.actions.playNext([Demo.dummyTracks[0]])
    session.actions.addToQueue(Demo.protectionTracks)
    #expect(session.player.queue.upcoming(5).map(\.title) == ["Mysterons", "Risingson", "Inertia Creeps", "Protection", "Karmacoma"])
    #expect(session.toasts.toasts.map(\.message) == ["“Mysterons” plays next", "Added 2 songs to the queue"])
    #expect(session.toasts.toasts.allSatisfy { $0.action?.label == "Undo" && $0.timeout == ToastCenter.undoTime })
    session.actions.playNext(Demo.protectionTracks)
    session.actions.addToQueue([Demo.dummyTracks[1]])
    #expect(session.toasts.toasts.suffix(2).map(\.message) == ["2 songs play next", "Added “Sour Times” to the queue"])
  }

  @Test func undoTakesThePlayNextBackOut() throws {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks)
    session.actions.playNext([Demo.dummyTracks[0]])
    session.toasts.perform(try #require(session.toasts.toasts.last))
    #expect(session.player.queue.upcoming(5).map(\.title) == ["Risingson", "Inertia Creeps"])
    #expect(session.player.queue.currentTrack?.title == "Angel")
  }

  @Test func undoTakesTheAddedSongsBackOutWhereverTheyWentSince() throws {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks)
    session.actions.addToQueue(Demo.protectionTracks)
    let undo = try #require(session.toasts.toasts.last)
    // Moved up in the meantime: they still leave.
    QueueModel(session: session).move(3, to: 0)
    session.toasts.perform(undo)
    #expect(session.player.queue.upcoming(5).map(\.title) == ["Risingson", "Inertia Creeps"])
  }

  @Test func undoLeavesANewQueueAlone() throws {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks)
    session.actions.playNext([Demo.dummyTracks[0]])
    let undo = try #require(session.toasts.toasts.last)
    session.player.play(Demo.dummyTracks + Demo.protectionTracks)
    session.toasts.perform(undo)
    #expect(session.player.queue.upcoming(5).map(\.title) == ["Sour Times", "Glory Box", "Protection", "Karmacoma"])
  }

  @Test func withNothingQueuedTheSongsJustPlay() {
    let session = demoSession()
    session.actions.playNext([Demo.dummyTracks[0]])
    #expect(session.player.queue.currentTrack?.title == "Mysterons")
    #expect(session.toasts.toasts.map(\.message) == ["Playing “Mysterons”"])
    #expect(session.toasts.toasts[0].action == nil)
  }

  @Test func startsARadioFromASong() async {
    let session = demoSession()
    await session.actions.startRadio(Demo.mezzanineTracks[0])
    #expect(session.player.queue.currentTrack?.title == "Angel")
    #expect(session.player.queue.source == PlaySource(label: "Angel radio", href: "/albums/70"))
    #expect(session.player.queue.queue.count == 1 + Demo.dummyTracks.count)
  }

  @Test func playsAndQueuesAlbums() async {
    let session = demoSession()
    await session.actions.playAlbum(80)
    #expect(session.player.queue.queue.map(\.title) == ["Mysterons", "Sour Times", "Glory Box"])
    #expect(session.player.queue.source == PlaySource(label: "Dummy", href: "/albums/80"))
    await session.actions.queueAlbum(71, next: true)
    #expect(session.player.queue.upcoming(2).map(\.title) == ["Protection", "Karmacoma"])
  }

  @Test func playsAPlaylistFromItsCard() async {
    let api = FakeAPI.demoLibrary()
    api.on(.get, "/api/playlists/\(Demo.lateNight.id)", Demo.lateNight)
    let session = demoSession(api: api)
    await session.actions.playPlaylist(Demo.lateNight.id, shuffle: false)
    #expect(session.player.queue.queue.map(\.title) == Demo.lateNight.items.compactMap(\.track?.title))
    #expect(session.player.queue.source == PlaySource(label: Demo.lateNight.name, href: "/playlists/\(Demo.lateNight.id)"))
  }

  @Test func goesToTheSongsAlbumAndArtist() {
    let session = demoSession()
    session.router.nowPlaying = true
    session.actions.goToAlbum(Demo.dummyTracks[0])
    session.actions.goToArtist(Demo.dummyTracks[0])
    #expect(session.router.paths[.home] == [.album(80), .artist(8)])
    #expect(!session.router.nowPlaying)
  }
}
