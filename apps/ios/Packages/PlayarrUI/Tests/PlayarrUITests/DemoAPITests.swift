import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct DemoAPITests {
  @Test func answersLikeARealServer() async throws {
    let api = DemoAPI()
    #expect(try await api.send(API.Library.album(id: 70)).missingTracks.count == 2)
    #expect(try await api.send(API.Library.artist(id: 7)).albums.map(\.title) == ["Mezzanine", "Protection"])
    #expect(try await api.send(API.Search.library("dummy")).albums.map(\.title) == ["Dummy"])
    #expect(try await api.send(API.Library.lyrics(trackId: 700)).lyrics == Demo.lyrics)
    #expect(try await api.send(API.Library.lyrics(trackId: 701)).lyrics == nil)
    #expect(try await api.send(API.Playback.radio(seeds: ["rec-700"])).count == 3)
    // Edit mix points draws the mix map the player plans with; a song the demo has no analysis for has none.
    let maps = try await api.send(API.Playback.mixMaps(ids: ["rec-700", "rec-702"]))
    #expect(maps.keys.sorted() == ["rec-700"])
    #expect(maps["rec-700"]?.bpm == 80)
  }

  @Test func readsTheArtistsDiscographyAsMusicBrainzWould() async throws {
    let massiveAttack = try await DemoAPI().send(API.Discover.artist(mbid: "art-1"))
    let groups = Discography.notInLibrary(massiveAttack, owned: Demo.artistDetail(Demo.artist).albums)
    #expect(groups.map(\.title) == ["Albums not in your library", "EPs & soundtracks not in your library"])
    #expect(groups.first?.albums.map(\.title) == ["Blue Lines", "100th Window", "Heligoland"])
  }

  @Test func showsEverySettingsPanelButChangesNone() async throws {
    let api = DemoAPI()
    #expect(try await api.send(API.Settings.mixes()).history.plays == 312)
    #expect(try await api.send(API.Settings.listenBrainz()).connected == false)
    #expect(try await api.send(API.Analysis.progress()).songs == Demo.tracks.count)
    #expect(try await api.send(API.Settings.requests()).options?.qualityProfiles.count == 2)
    let updates = try await api.send(API.Settings.updates())
    #expect(updates.status?.deployed == updates.status?.latest)
    #expect(try await api.send(API.Server.info()) == Demo.server)
    // The demo's server stays as it is, and says so.
    await #expect(throws: Demo.unchanged) { try await api.send(API.Settings.saveUpdates(UpdateSettingsPatch(enabled: false))) }
    await #expect(throws: Demo.unchanged) { try await api.send(API.Analysis.run(nil)) }
  }

  @Test func saysNotFoundForTheRest() async {
    await #expect(throws: APIError.server(status: 404, message: "Not found")) { try await DemoAPI().send(API.Library.album(id: 1)) }
  }
}
