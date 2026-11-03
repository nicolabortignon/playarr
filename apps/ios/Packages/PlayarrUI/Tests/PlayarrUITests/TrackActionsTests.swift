import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct TrackActionsTests {
  @Test func queuesSongsAndSaysSo() {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks)
    session.actions.playNext([Demo.dummyTracks[0]])
    session.actions.addToQueue(Demo.protectionTracks)
    #expect(session.player.queue.upcoming(5).map(\.title) == ["Mysterons", "Risingson", "Inertia Creeps", "Protection", "Karmacoma"])
    #expect(session.toasts.toasts.map(\.message) == ["Playing 1 track next", "Added 2 tracks to queue"])
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

  @Test func goesToTheSongsAlbumAndArtist() {
    let session = demoSession()
    session.router.nowPlaying = true
    session.actions.goToAlbum(Demo.dummyTracks[0])
    session.actions.goToArtist(Demo.dummyTracks[0])
    #expect(session.router.paths[.home] == [.album(80), .artist(8)])
    #expect(!session.router.nowPlaying)
  }
}
