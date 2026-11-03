import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct RequestButtonStateTests {
  private func state(_ a: Availability, allowed: Bool = true, pending: PendingRequest? = nil) -> RequestButtonState {
    RequestButtonState.make(a, allowed: allowed, pending: pending)
  }

  @Test func saysEachStateInTheWebsWords() {
    #expect(state(availability(.noneValue)).label == "Request")
    #expect(state(availability(.searching)).label == "Searching")
    #expect(state(availability(.downloading, progress: 0.425)).label == "43%")
    #expect(state(availability(.downloading)).label == "0%")
    #expect(state(availability(.importing)).label == "Importing")
    #expect(state(availability(.waiting)).label == "Search again")
    #expect(state(availability(.failed)).label == "Retry")
    #expect(state(availability(.available, albumId: 5)) == .inLibrary(albumId: 5))
    #expect(state(availability(.available, albumId: 5)).label == "In library")
  }

  @Test func saysRequestingThenLookingUp() {
    #expect(state(availability(.noneValue), pending: .requesting).label == "Requesting")
    let slow = state(availability(.failed), pending: .lookingUp)
    #expect(slow.label == "Looking up")
    #expect(slow.help == "Finding this album on MusicBrainz, which answers about one request per second")
  }

  @Test func countsWhatIsHereOfAPartialAlbum() {
    let some = state(availability(.partial, albumId: 5, have: 1, total: 12))
    #expect(some == .partial(count: "1/12", summary: "1 of 12 songs in your library", albumId: 5, canRequest: true))
    #expect(state(availability(.partial, albumId: 5, have: 3)).label == "3 here")
    #expect(state(availability(.partial, have: 1)).help == "1 song in your library")
    #expect(state(availability(.partial, albumId: 5, have: 1, total: 12), allowed: false).opensAlbum == 5)
  }

  @Test func hidesWhatWouldAskWhenRequestsArentAllowed() {
    for s: AvailabilityState in [.noneValue, .waiting, .failed, .unknown("new")] {
      #expect(state(availability(s), allowed: false) == .hidden)
    }
    // Progress on earlier requests still shows, and In library still opens the album.
    #expect(state(availability(.searching), allowed: false).label == "Searching")
    #expect(state(availability(.available, albumId: 9), allowed: false).opensAlbum == 9)
    #expect(state(availability(.partial, have: 2, total: 9), allowed: false) == .partial(count: "2/9", summary: "2 of 9 songs in your library", albumId: nil, canRequest: false))
  }

  @Test func asksOnlyFromTheStatesThatCan() {
    #expect(state(availability(.noneValue)).asks)
    #expect(state(availability(.waiting, message: "No release found")).asks)
    #expect(state(availability(.waiting, message: "No release found")).help == "No release found")
    #expect(state(availability(.failed)).asks)
    #expect(!state(availability(.searching)).asks)
    #expect(!state(availability(.available)).asks)
  }

  @Test func namesAnAlbumByItsIdElseByArtistAndTitle() {
    #expect(AlbumRef(mbid: "rg-1", artistName: "Massive Attack", albumTitle: "Mezzanine").requestKey == "rg-1")
    #expect(AlbumRef(artistName: "Massive Attack", albumTitle: "Mezzanine (Deluxe)").requestKey == "massive attack|mezzanine")
  }
}
