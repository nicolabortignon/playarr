import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct MixesStoreTests {
  let api = FakeAPI()

  @Test func asksInTheDevicesTimeZone() async {
    api.on(.get, "/api/mixes", [Listening.summary(Listening.mix())])
    let mixes = MixesStore(api: api, queries: QueryCache(directory: nil), timeZone: TimeZone(identifier: "Europe/Rome")!)
    await mixes.load()
    #expect(api.queries(.get, "/api/mixes", "tz") == ["Europe/Rome"])
    #expect(mixes.mixes?.map(\.title) == ["Your vibes"])
  }

  @Test func asksAgainWhenTheNextMixIsDue() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    #expect(MixesStore.recheck(due: [now.addingTimeInterval(3600), now.addingTimeInterval(60)], now: now) == .seconds(65))
    #expect(MixesStore.recheck(due: [now.addingTimeInterval(-30)], now: now) == .seconds(15))
    #expect(MixesStore.recheck(due: [], now: now) == .seconds(60))
  }

  @Test func keepsAskingWhileTheScreenIsUp() async {
    let clock = TestClock()
    api.on(.get, "/api/mixes", [Listening.summary(Listening.mix(refreshesAt: "2000-01-01T00:00:00.000Z"))])
    let mixes = MixesStore(api: api, queries: QueryCache(directory: nil), clock: clock)
    let polling = Task { await mixes.poll() }
    #expect(await clock.nextSleep() == .seconds(15))
    clock.advance(by: .seconds(15))
    _ = await clock.nextSleep()
    polling.cancel()
    await polling.value
    #expect(api.calls(.get, "/api/mixes").count == 2)
  }
}
