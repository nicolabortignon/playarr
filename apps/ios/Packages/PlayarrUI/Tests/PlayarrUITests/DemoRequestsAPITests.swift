import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

/// The demo server the requesting UI test runs against behaves as that test expects.
@MainActor @Suite struct DemoRequestsAPITests {
  private let heligoland = AlbumRef(mbid: "rg-heligoland", artistName: "Massive Attack", albumTitle: "Heligoland")

  private func context(_ asker: DemoRequestsAPI.Asker, _ log: EventLog) -> DiscoverContext {
    DiscoverContext(api: DemoRequestsAPI(asker), account: asker.account, clock: TestClock(), toast: log.toast)
  }

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
    // Ready, and news until Requests shows it.
    #expect(context.requests.newsCount == 1)
    await context.requests.opened()
    #expect(context.requests.newsCount == 0)
    await context.requests.refresh()
    #expect(context.requests.requests?.first?.unseen == false)
  }

  @Test func aMemberWhoAsksFirstWaitsForAnAdminThenGetsTheAlbum() async throws {
    let log = EventLog()
    let context = context(.asksFirst, log)
    await context.refreshHealth()
    #expect(context.gate.asksFirst)
    // Blue Lines was declined: news, and taken off the list with Remove.
    await context.requests.refresh()
    #expect(context.requests.requests?.map(\.approval) == [.declined])
    #expect(context.requests.newsCount == 1)
    context.requests.request(heligoland)
    // Done once the requests have been asked for again.
    await eventually { context.requests.pendingState(for: heligoland) == nil }
    #expect(log.toasts == ["Requested “Heligoland”. It goes to Lidarr once an admin approves it"])
    let found = try #require(try await context.discover("Heligoland").albums.first)
    #expect(found.availability.state == .noneValue)
    #expect(context.requests.buttonState(for: heligoland, availability: found.availability, allowed: true) == .awaitingApproval)
    // An admin approves it by the second look; it lands two looks later.
    await context.requests.refresh()
    #expect(context.requests.requests?.first?.availability.state == .searching)
    await context.requests.refresh()
    await context.requests.refresh()
    #expect(log.toasts.last == "“Heligoland” is ready to play")
    #expect(context.requests.newsCount == 2)
    context.requests.hide(try #require(context.requests.requests?.last))
    await context.requests.remove(try #require(context.requests.requests?.last))
    #expect(context.requests.requests?.map(\.title) == ["Heligoland"])
  }

  @Test func anAdminAnswersSamsRequest() async throws {
    let log = EventLog()
    let context = context(.admin, log)
    await context.requests.refresh()
    let sams = try #require(context.requests.requests?.first)
    #expect(sams.approval == .waiting && sams.mine == false && sams.askedBy == ["Sam"])
    #expect(context.requests.newsCount == 1)
    await context.requests.approve(sams)
    #expect(log.toasts == ["Approved “Heligoland”. Lidarr is searching for it"])
    #expect(context.requests.newsCount == 0)
    await context.requests.refresh()
    #expect(context.requests.requests?.first?.availability.state == .available)
    // Sam's arrival: in the library, but news to Sam, not to the admin.
    #expect(log.toasts.count == 1)
    #expect(context.requests.newsCount == 0)
  }

  @Test func anAdminDeclinesSamsRequest() async throws {
    let log = EventLog()
    let context = context(.admin, log)
    await context.requests.refresh()
    await context.requests.decline(try #require(context.requests.requests?.first))
    #expect(log.toasts == ["Declined “Heligoland”"])
    #expect(context.requests.requests?.first?.availability.message == "Declined by you")
  }

  @Test func theRestIsTheDemoLibrary() async throws {
    let albums = try await DemoRequestsAPI().send(API.Library.albums(sort: .artist))
    #expect(albums == Demo.albums)
  }

  @Test func theDemoAppCanStartReadyToRequest() {
    let model = AppModel.demo(requests: .member)
    #expect(model.session?.account == DemoRequestsAPI.account)
    #expect(model.session?.discover.gate.canRequest == true)
  }

  @Test func picksWhoTheDemoIsSignedInAsFromItsLaunchArguments() {
    #expect(DemoRequestsAPI.Asker(arguments: ["-UITests"]) == nil)
    #expect(DemoRequestsAPI.Asker(arguments: ["-UITests", "-UITestsRequests"]) == .member)
    #expect(DemoRequestsAPI.Asker(arguments: ["-UITestsRequests", "asks-first"]) == .asksFirst)
    #expect(DemoRequestsAPI.Asker(arguments: ["-UITestsRequests", "admin", "-UITestsRestore"]) == .admin)
    #expect(DemoRequestsAPI.Asker(arguments: ["-UITestsRequests", "-UITestsRestore"]) == .member)
    #expect(AppModel.demo(requests: .admin).session?.account.role == .admin)
  }
}
