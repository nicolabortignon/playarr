import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

/// The lines of docs/design.md ("Empty, loading and error" → The lines), word for word: the web says the same.
@MainActor @Suite struct PageLinesTests {
  @Test func everyEmptyPageSaysItsLine() {
    #expect(PageLines.queue == PageLines.Line("The deck’s empty."))
    #expect(PageLines.favorites == PageLines.Line("No hearts yet.", "Heart a song and it lands here."))
    #expect(
      PageLines.downloads
        == PageLines.Line(
          "Nothing in the record bag yet.", "Download an album, a playlist or a mix, and it plays here with or without a connection."))
    #expect(PageLines.playlists == PageLines.Line("Make a playlist for a mood, a trip or a friend."))
    #expect(PageLines.artist("Massive Attack") == PageLines.Line("Nothing by Massive Attack here yet."))
    #expect(PageLines.mixes == PageLines.Line("Your mixes are on their way.", "They appear as you listen, and as Playarr learns your library."))
    #expect(PageLines.stats == PageLines.Line("No spins in this period yet.", "A song counts once it’s heard for 30 seconds."))
    #expect(PageLines.failed == "The needle skipped.")
  }

  @Test func onlyAPlaylistsOwnerIsToldHowToFillIt() {
    #expect(
      PageLines.playlist(mine: true)
        == PageLines.Line("This playlist is waiting for its first song.", "Choose Add to playlist… in any song’s ⋯ menu."))
    #expect(PageLines.playlist(mine: false) == PageLines.Line("Nothing in this playlist yet."))
  }

  @Test func anEmptyLibraryTellsAnAdminHowToFillItAndAMemberWhoCan() {
    #expect(PageLines.albums(admin: true) == PageLines.Line("Your crates are empty.", "Add Lidarr or a folder of music, and it shows up here."))
    #expect(PageLines.albums(admin: false) == PageLines.Line("Your crates are empty.", "Music shows up here once an admin adds some."))
    #expect(PageLines.artists(admin: true) == PageLines.Line("Nobody on the roster yet.", "Add Lidarr or a folder of music, and it shows up here."))
    #expect(PageLines.artists(admin: false).hint == "Music shows up here once an admin adds some.")
  }

  @Test func anEmptySearchSaysWhatFollowsOrWhatToTry() {
    #expect(PageLines.search("mezanine") == PageLines.Line("Not in your crates.", "Nothing in your library matches “mezanine”."))
    #expect(PageLines.search("mezanine", beyond: true).hint == "Nothing in your library matches “mezanine”. Here’s what’s out there:")
    #expect(
      PageLines.search("zzz", nothingAnywhere: true).hint
        == "Nothing in your library or beyond it matches “zzz”. Check the spelling, try fewer words, or pick an artist you have.")
    #expect(PageLines.near("mezanine") == "Nothing called “mezanine”. These come close:")
  }

  // MARK: What fills a page that listening fills

  @Test func anEmptyQueueOffersFeelingLuckyAndTheAlbumHeardLastBesideIt() {
    var played: [Int] = []
    let queue = ListeningEmptyState.actions(heardLast: album(), luckyFirst: true) { played.append($0.id) }
    guard case .lucky = queue.fill else {
      Issue.record("Feeling lucky leads the queue")
      return
    }
    #expect(queue.secondary?.title == "Jump back in")
    #expect(queue.secondary?.hint == "Plays Mezzanine, the album heard last")
    queue.secondary?.perform()
    #expect(played == [70])
  }

  @Test func emptyFavoritesOfferJumpBackInAndFeelingLuckyOnlyWithNothingHeard() {
    var played: [Int] = []
    let favorites = ListeningEmptyState.actions(heardLast: album(), luckyFirst: false) { played.append($0.id) }
    guard case .action(let jump) = favorites.fill else {
      Issue.record("Jump back in fills Favorites")
      return
    }
    #expect(jump.title == "Jump back in")
    #expect(favorites.secondary == nil)
    jump.perform()
    #expect(played == [70])
    for luckyFirst in [false, true] {
      let fresh = ListeningEmptyState.actions(heardLast: nil, luckyFirst: luckyFirst) { _ in }
      guard case .lucky = fresh.fill else {
        Issue.record("Feeling lucky fills a page when nothing has been heard")
        return
      }
      #expect(fresh.secondary == nil)
    }
  }

  // MARK: Part of a page that failed

  @Test func aPartThatFailedSaysWhatHappenedAndWhy() {
    #expect(InlineError.text(what: "Couldn’t reach ListenBrainz", reason: "timed out") == "Couldn’t reach ListenBrainz: timed out")
    #expect(InlineError.text(what: "Couldn’t reach ListenBrainz", reason: nil) == "Couldn’t reach ListenBrainz")
    #expect(InlineError.text(what: nil, reason: "timed out") == "timed out")
    #expect(InlineError.text(what: nil, reason: nil) == "Something went wrong")
  }

  // MARK: Album cards

  @Test func anAlbumCardOnItsArtistsPageSaysWhatItIsInPlaceOfTheirName() {
    #expect(AlbumCard.subtitle(album(have: 3, total: 11), onArtistPage: false) == "Massive Attack · 3 of 11")
    var ep = album(type: "EP")
    ep.year = 2019
    #expect(AlbumCard.subtitle(ep, onArtistPage: true) == "EP · 2019")
    #expect(AlbumCard.subtitle(ep, onArtistPage: false) == "Massive Attack · 2019")
  }
}

/// What Requests says with nothing on it, by what the server allows and who's asking (pages/Requests.tsx NoRequests).
@Suite struct NoRequestsTests {
  func gate(lidarr: Bool = true, requests: Bool = true, canRequest: Bool = true) -> RequestGate {
    RequestGate(health: health(lidarr: lidarr, requests: requests), account: account(canRequest: canRequest))
  }

  @Test func saysWhyRequestingIsntPossible() {
    #expect(NoRequests.of(gate(), admin: false) == .ask)
    #expect(NoRequests.of(gate(lidarr: false, requests: false), admin: true) == .needsLidarr(admin: true))
    // Without Lidarr that's the reason, whatever else is off.
    #expect(NoRequests.of(gate(lidarr: false, requests: false, canRequest: false), admin: false) == .needsLidarr(admin: false))
    #expect(NoRequests.of(gate(canRequest: false), admin: false) == .cantRequest(admin: false))
    #expect(NoRequests.of(gate(requests: false), admin: true) == .turnedOff(admin: true))
  }

  @Test func offersAnAdminTheWayToChangeItAndTellsAMemberWhoCan() {
    #expect(
      NoRequests.needsLidarr(admin: true).line
        == PageLines.Line("Requests need a Lidarr source.", "Add one, and you can ask Lidarr for albums you don’t have, right from Search."))
    #expect(NoRequests.needsLidarr(admin: true).action == .init(title: "Add Lidarr", systemImage: "gearshape", destination: .settings(.sources)))
    #expect(
      NoRequests.needsLidarr(admin: false).line
        == PageLines.Line("Requests aren’t set up on this server.", "They need a Lidarr source, which an admin can add."))
    #expect(NoRequests.needsLidarr(admin: false).action == nil)
    #expect(NoRequests.turnedOff(admin: true).line.title == "Requests are turned off.")
    #expect(NoRequests.turnedOff(admin: true).action?.destination == .settings(.requests))
    #expect(NoRequests.turnedOff(admin: false).line == PageLines.Line("Requests are turned off on this server.", "An admin can turn them on."))
    #expect(NoRequests.turnedOff(admin: false).action == nil)
    #expect(NoRequests.cantRequest(admin: false).line == PageLines.Line("Your account can’t request albums.", "An admin can allow it."))
    #expect(NoRequests.cantRequest(admin: true).line.hint == "Allow it for yourself in Settings → Accounts.")
    #expect(NoRequests.cantRequest(admin: true).action == nil)
    #expect(NoRequests.ask.action == .init(title: "Search", systemImage: "magnifyingglass", destination: .search))
  }
}
