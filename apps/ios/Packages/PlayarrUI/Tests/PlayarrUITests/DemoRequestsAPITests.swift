import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

/// The demo server the requesting UI test runs against behaves as that test expects.
@MainActor @Suite struct DemoRequestsAPITests {
  @Test func anAlbumRequestedFromSearchLandsOnTheSecondLook() async throws {
    let log = EventLog()
    let context = DiscoverContext(api: DemoRequestsAPI(), account: DemoRequestsAPI.account, clock: TestClock(), toast: log.toast)
    await context.refreshHealth()
    #expect(context.gate.allowsRequests)
    let found = try await context.discover("Heligoland")
    let album = try #require(found.albums.first)
    let ref = AlbumRef(mbid: album.mbid, artistName: album.artistName, albumTitle: album.title)
    #expect(context.requests.buttonState(for: ref, availability: album.availability, allowed: true) == .request)
    context.requests.request(ref)
    await eventually { log.toasts.count == 1 }
    #expect(log.toasts == ["Requested “Heligoland”. Lidarr is searching for it"])
    #expect(try await context.discover("Heligoland").albums.first?.availability.state == .searching)
    await context.requests.refresh()
    #expect(log.toasts.last == "“Heligoland” is ready to play")
  }

  @Test func theRestIsTheDemoLibrary() async throws {
    let albums = try await DemoRequestsAPI().send(API.Library.albums(sort: .artist))
    #expect(albums == Demo.albums)
  }

  @Test func theDemoAppCanStartReadyToRequest() {
    let model = AppModel.demo(requests: true)
    #expect(model.session?.account == DemoRequestsAPI.account)
    #expect(model.session?.discover.gate.canRequest == true)
  }
}
