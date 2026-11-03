import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct DiscoverContextTests {
  let log = EventLog()

  private func context(_ api: FakeAPI, forward: @escaping @MainActor ([CacheFamily]) -> Void = { _ in }) -> DiscoverContext {
    DiscoverContext(api: api, account: account(), clock: TestClock(), toast: log.toast, forward: forward)
  }

  @Test func followsTheServersHealthAndTheAccount() async {
    let api = FakeAPI()
    api.on(.get, "/api/health", health(requests: false))
    let context = context(api)
    #expect(context.gate.allowsRequests)  // health not known yet
    await context.refreshHealth()
    #expect(!context.gate.allowsRequests)
    #expect(context.gate.hasLidarr)
    context.update(account(canRequest: false))
    #expect(!context.gate.canRequest)
  }

  @Test func marksAnswersStaleHereAndInTheApp() {
    var forwarded: [CacheFamily] = []
    let context = context(FakeAPI()) { forwarded += $0 }
    context.invalidate([.discover, .albums, .discover])
    #expect(context.generation(.discover) == 1)
    #expect(context.generation(.albums) == 1)
    #expect(context.generation(.search) == 0)
    #expect(forwarded == [.discover, .albums, .discover])
  }

  @Test func keepsADiscographyAMinuteUnlessItGoesStale() async throws {
    let api = FakeAPI()
    api.on(.get, "/api/discover/artists/a-1", DiscoverArtistDetail(mbid: "a-1", name: "Air", genres: [], albums: []))
    let context = context(api)
    _ = try await context.discoverArtist("a-1")
    _ = try await context.discoverArtist("a-1")
    #expect(api.calls.count == 1)
    context.invalidate([.discoverArtist])
    _ = try await context.discoverArtist("a-1")
    #expect(api.calls.count == 2)
  }

  @Test func aRequestThatLandsRefreshesDiscover() async {
    let api = FakeAPI()
    api.on(.get, "/api/requests", [albumRequest("rg-1", "Mezzanine", .importing)])
    api.then(.get, "/api/requests", [albumRequest("rg-1", "Mezzanine", .available, albumId: 70)])
    let context = context(api)
    await context.requests.refresh()
    await context.requests.refresh()
    #expect(context.generation(.discover) == 1)
    #expect(context.generation(.discoverArtist) == 1)
    #expect(log.toasts == ["“Mezzanine” is ready to play"])
  }

  @Test func asksForHealthEveryMinuteAndTheRequestsUntilStopped() async {
    let api = FakeAPI()
    api.on(.get, "/api/health", health())
    api.on(.get, "/api/requests", [AlbumRequest]())
    let clock = TestClock()
    let context = DiscoverContext(api: api, account: account(), clock: clock, toast: log.toast)
    context.start()
    await eventually { clock.sleeping == 2 }
    #expect(clock.pendingSleep == .seconds(60))
    clock.advance(by: .seconds(60))
    await eventually { clock.sleeping == 2 && api.calls(.get, "/api/health").count == 2 }
    #expect(api.calls(.get, "/api/requests").count == 2)
    context.stop()
    clock.advance(by: .seconds(60))
    try? await Task.sleep(for: .milliseconds(20))
    #expect(api.calls(.get, "/api/health").count == 2)
    #expect(context.health == health())
  }
}
