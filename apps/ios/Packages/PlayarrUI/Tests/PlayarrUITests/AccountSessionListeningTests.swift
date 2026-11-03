import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct AccountSessionListeningTests {
  @Test func eachSessionHasItsOwnFavoritesPlaylistsAndMixes() async {
    let api = FakeAPI.demoLibrary()
    let session = demoSession(api: api)
    await session.refreshListening()
    #expect(session.favorites.isFavorite("rec-701"))
    #expect(session.playlists.playlists?.map(\.name) == ["Late night"])
    #expect(session.mixes.mixes?.map(\.key) == ["vibes"])
    #expect(demoSession(api: FakeAPI()).favorites.tracks == nil)
  }

  @Test func opensAddToPlaylistFromAnyScreen() {
    let session = demoSession()
    session.addToPlaylist([Listening.angel])
    #expect(session.picking?.tracks.map(\.title) == ["Angel"])
  }

  @Test func savesTheQueueFromTheSongPlayingOn() {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks + Demo.protectionTracks, startAt: 1)
    #expect(AccountSession.queueToSave(session.player.queue).map(\.title) == ["Risingson", "Inertia Creeps", "Protection", "Karmacoma"])
    #expect(AccountSession.queueToSave(QueueState()).isEmpty)
  }
}
