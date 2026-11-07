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
  }

  @Test func readsTheArtistsDiscographyAsMusicBrainzWould() async throws {
    let massiveAttack = try await DemoAPI().send(API.Discover.artist(mbid: "art-1"))
    let groups = Discography.notInLibrary(massiveAttack, owned: Demo.artistDetail(Demo.artist).albums)
    #expect(groups.map(\.title) == ["Albums not in your library", "EPs & soundtracks not in your library"])
    #expect(groups.first?.albums.map(\.title) == ["Blue Lines", "100th Window", "Heligoland"])
  }

  @Test func saysNotFoundForTheRest() async {
    await #expect(throws: APIError.server(status: 404, message: "Not found")) { try await DemoAPI().send(API.Library.album(id: 1)) }
  }
}
