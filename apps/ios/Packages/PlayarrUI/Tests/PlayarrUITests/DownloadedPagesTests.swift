import PlayarrPlayer
import Testing
@testable import PlayarrUI

struct DownloadedPagesTests {
  @Test func aDownloadKeepsItsPageAndTheListLeadingToIt() {
    func keys(_ key: String) -> [[String]] { PinnedDownload(key: key, title: "", href: "", tracks: []).pageKeys }
    #expect(keys(PinnedDownload.Key.album(12)) == [["album", "12"], ["albums", "artist"]])
    #expect(keys(PinnedDownload.Key.playlist(3)) == [["playlist", "3"], ["playlists"]])
    #expect(keys(PinnedDownload.Key.mix("genre-electronic")) == [["mix", "genre-electronic"], ["mixes"]])
    #expect(keys(PinnedDownload.Key.favorites) == [["favorites"]])
  }
}
