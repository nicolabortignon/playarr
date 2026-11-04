import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct QuickPlayTests {
  @Test func playsTheFavoritesInOrder() async throws {
    let api = FakeAPI()
    let favorites = Demo.mezzanineTracks.map {
      FavoriteTrack(
        id: $0.id, recordingId: $0.recordingId, fileId: $0.fileId, albumId: $0.albumId, artistId: $0.artistId, title: $0.title,
        artistName: $0.artistName, albumTitle: $0.albumTitle, trackNumber: $0.trackNumber, discNumber: $0.discNumber,
        duration: $0.duration, explicit: false, format: $0.format, size: $0.size, streamUrl: $0.streamUrl, coverUrl: $0.coverUrl,
        favoritedAt: "2026-11-01T12:00:00.000Z")
    }
    api.on(.get, "/api/favorites", favorites)
    let session = demoSession(api: api)
    try await QuickPlay(session: session).playFavorites()
    #expect(session.player.queue.queue.map(\.title) == ["Angel", "Risingson", "Inertia Creeps"])
    #expect(session.player.queue.source == PlaySource(label: "Favorites", href: "/favorites"))
  }

  @Test func saysWhyItCant() async {
    let api = FakeAPI()
    api.on(.get, "/api/favorites", [FavoriteTrack]())
    api.on(.post, "/api/lucky", LuckyMix(tracks: [], subtitle: "Evening: warm"))
    await #expect(throws: QuickPlay.Failure.noFavorites) { try await QuickPlay(session: demoSession(api: api)).playFavorites() }
    await #expect(throws: QuickPlay.Failure.signedOut) { try await QuickPlay(session: nil).feelingLucky() }
    await #expect(throws: QuickPlay.Failure.nothingPlaying) { try await QuickPlay(session: demoSession(api: api)).startRadio() }
    await #expect(throws: QuickPlay.Failure.emptyLibrary) { try await QuickPlay(session: demoSession(api: api)).feelingLucky() }
    api.fail(.post, "/api/lucky", status: 500, "Lidarr is down")
    await #expect(throws: QuickPlay.Failure.server("Lidarr is down")) { try await QuickPlay(session: demoSession(api: api)).feelingLucky() }
  }

  @Test func feelsLuckyAndStartsARadio() async throws {
    let api = FakeAPI()
    api.on(.post, "/api/lucky", LuckyMix(tracks: Demo.dummyTracks, subtitle: "Evening: warm"))
    api.on(.post, "/api/radio", Demo.protectionTracks)
    let session = demoSession(api: api)
    try await QuickPlay(session: session).feelingLucky()
    #expect(session.player.queue.source == PlaySource(label: "Feeling lucky · Evening: warm", href: "/"))
    let playing = try #require(session.player.queue.currentTrack)
    try await QuickPlay(session: session).startRadio()
    #expect(session.player.queue.source?.label == "\(playing.title) radio")
  }
}
