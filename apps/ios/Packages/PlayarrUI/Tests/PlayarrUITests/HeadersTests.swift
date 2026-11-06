import CoreGraphics
import PlayarrAPI
import Testing
@testable import PlayarrUI

/// The page and detail headers' pure parts (docs/design.md, "Headers").
@MainActor @Suite struct HeadersTests {
  @Test func aMetaLineJoinsItsPartsWithDotsLeavingOutTheEmptyOnes() {
    #expect(MetaLine.join(["3 songs", "17 min", "Changes in 9 h"]) == "3 songs · 17 min · Changes in 9 h")
    #expect(MetaLine.join([nil, "12 releases", "", "3 in your library"]) == "12 releases · 3 in your library")
    #expect(MetaLine.join([nil, ""]) == "")
  }

  @Test func aPhonesCoverLeavesRoomForPlayOnTheFirstScreen() {
    #expect(DetailCover.side(width: 402, round: false) == 256)
    #expect(DetailCover.side(width: 375, round: false) == 240)
    #expect(DetailCover.side(width: 402, round: true) == 160)
    #expect(DetailCover.side(width: 320, round: true) == 128)
  }

  @Test func aPlaylistsOwnCoverLeavesItsNameOff() {
    #expect(PlaylistCover.path("/art/playlist/1?v=3", points: 256, titled: true) == "/art/playlist/1?v=3")
    #expect(PlaylistCover.path("/art/playlist/1?v=3", points: 256, titled: false) == "/art/playlist/1?v=3&title=0")
    #expect(PlaylistCover.path("/art/playlist/1", points: 56, titled: true) == "/art/playlist/1?title=0")
  }

  @Test func onTheArtistsOwnPageACardSaysWhatItIsAndWhenRatherThanWho() {
    let ep = DiscoverAlbum(
      mbid: "rg-1", title: "Ritual Spirit", artistName: "Massive Attack", artistMbid: "art-1", year: 2019, type: "EP", secondaryTypes: [],
      availability: availability(.noneValue))
    #expect(DiscoverAlbumCard.byline(ep, onArtistPage: true) == "EP · 2019")
    #expect(DiscoverAlbumCard.byline(ep, onArtistPage: false) == "Massive Attack · 2019")
    var live = ep
    live.type = "Album"
    live.secondaryTypes = ["Live"]
    live.year = nil
    #expect(DiscoverAlbumCard.byline(live, onArtistPage: true) == "Live album")
  }

  @Test func theDuosColumnIsTheMarginOnTheRightOfAnUprightScreen() {
    #expect(UnderTheRail.railWidth(size: CGSize(width: 466, height: 678), trailingInset: 73) == 73)
    // An iPhone turned on its side keeps margins on both sides: not the Duo's column.
    #expect(UnderTheRail.railWidth(size: CGSize(width: 874, height: 402), trailingInset: 62) == 0)
    #expect(UnderTheRail.railWidth(size: CGSize(width: 402, height: 874), trailingInset: 0) == 0)
  }
}
