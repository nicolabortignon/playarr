import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct AlbumDetailTests {
  @Test func takesTheAlbumOutOfAnAlbumPage() {
    let detail = AlbumDetail(
      id: 70, title: "Mezzanine", artistId: 7, artistName: "Massive Attack", albumType: "Album", secondaryTypes: [], genres: [],
      duration: 3000, trackCount: 3, totalTrackCount: 11, mbid: "rg-1", tracks: [], discCount: 1, missingTracks: [])
    #expect(Album(detail) == album(mbid: "rg-1", have: 3, total: 11))
  }
}
