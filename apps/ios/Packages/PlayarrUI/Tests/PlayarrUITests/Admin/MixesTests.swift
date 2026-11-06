import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct MixesTests {
  let api = FakeAPI()

  static func settings(plays: Int = 1234, timeZone: String? = nil, discovery: Bool? = nil) -> MixSettingsInfo {
    MixSettingsInfo(
      enabled: .init(discovery: discovery), length: 50, adventurous: 0.4, blastDays: 90, genreMixes: 2, decadeMixes: 2,
      recordHistory: true, analyzeLibrary: false, timeZone: timeZone, analysisAvailable: true,
      history: .init(plays: plays, since: plays > 0 ? "2026-01-05T10:00:00Z" : nil))
  }

  func model(admin: Bool = true) -> MixSettingsModel {
    MixSettingsModel(api: api, isAdmin: admin, deviceTimeZone: "Europe/London")
  }

  @Test func countsMissingKindsAsOnAndSavesOneSwitch() async {
    let mixes = model()
    api.on(.get, "/api/settings/mixes", Self.settings(discovery: false))
    await mixes.load()
    #expect(mixes.isEnabled(.vibes) && !mixes.isEnabled(.discovery))
    api.on(.put, "/api/settings/mixes", Self.settings(discovery: true))
    await mixes.setEnabled(.discovery, true)
    #expect(api.bodies(.put, "/api/settings/mixes") == [#"{"enabled":{"discovery":true}}"#])
    #expect(mixes.isEnabled(.discovery))
  }

  @Test func putsAChangeBackWhenTheServerRefusesIt() async {
    let mixes = model()
    api.on(.get, "/api/settings/mixes", Self.settings())
    await mixes.load()
    api.fail(.put, "/api/settings/mixes", status: 403, "Only an admin can change this")
    await mixes.setLength(100)
    #expect(mixes.info?.length == 50)
    #expect(mixes.notice == "Couldn’t save: Only an admin can change this" && mixes.failed)
  }

  @Test func offersThisDevicesTimeZone() async {
    let mixes = model()
    api.on(.get, "/api/settings/mixes", Self.settings())
    await mixes.load()
    #expect(mixes.timeZoneText == "The server’s")
    #expect(mixes.useDeviceZoneLabel == "Use this device’s (Europe/London)")
    api.on(.put, "/api/settings/mixes", Self.settings(timeZone: "Europe/London"))
    await mixes.useDeviceTimeZone()
    #expect(api.bodies(.put, "/api/settings/mixes") == [#"{"timeZone":"Europe/London"}"#])
    #expect(mixes.useDeviceZoneLabel == nil)
  }

  @Test func picksTheNearestAdventureAndSaysTheHistory() async {
    let mixes = model(admin: false)
    api.on(.get, "/api/settings/mixes", Self.settings())
    await mixes.load()
    #expect(mixes.adventure == 0.5)
    #expect(mixes.historyText.hasPrefix("1234 songs played since "))
    #expect(mixes.canClear)
  }

  @Test func clearsTheHistoryAfterAsking() async {
    var mixesChanged = 0
    let mixes = MixSettingsModel(api: api, isAdmin: false, deviceTimeZone: "Europe/London") { mixesChanged += 1 }
    api.on(.get, "/api/settings/mixes", Self.settings())
    await mixes.load()
    api.on(.delete, "/api/settings/mixes/history", Self.settings(plays: 0))
    await mixes.clearHistory()
    #expect(mixes.historyText == "Nothing played yet" && !mixes.canClear)
    #expect(mixes.notice == "Listening history cleared")
    #expect(mixesChanged == 1)
  }

  @Test func asksBeforeClearingTheHistorySayingWhatGoesAndWhatStays() {
    #expect(
      MixSettingsModel.clearQuestion(plays: 1234)
        == LossQuestion(
          title: "Clear listening history?",
          message: "All 1234 songs played are forgotten for good, and the mixes start learning again from scratch. Favorites and playlists stay.",
          verb: "Clear history"))
    #expect(MixSettingsModel.clearQuestion(plays: 1).message.hasPrefix("Every song played is forgotten for good"))
  }

  @Test func connectsListenBrainzAndSaysWhatIsSent() async {
    let lb = ListenBrainzModel(api: api)
    api.on(.get, "/api/settings/listenbrainz", ListenBrainzInfo(connected: false, enabled: false, pending: 0, sent: 0, earlier: 0))
    await lb.load()
    lb.token = "  "
    #expect(!lb.canConnect)
    lb.token = " tok "
    api.on(.put, "/api/settings/listenbrainz", ListenBrainzInfo(connected: true, user: "nicola", enabled: true, pending: 3, sent: 120, earlier: 1200))
    await lb.connect()
    #expect(api.bodies(.put, "/api/settings/listenbrainz") == [#"{"token":"tok"}"#])
    #expect(lb.token.isEmpty)
    #expect(lb.switchLabel == "Send plays to nicola")
    #expect(lb.switchDetail == "120 listens sent · 3 waiting")
    #expect(lb.earlierLabel == "Also send 1200 earlier plays")
  }

  @Test func pausesSendsEarlierPlaysAndDisconnects() async {
    let lb = ListenBrainzModel(api: api)
    let on = ListenBrainzInfo(connected: true, user: "nicola", enabled: true, pending: 0, sent: 1, earlier: 0, error: "The token was revoked")
    api.on(.get, "/api/settings/listenbrainz", on)
    await lb.load()
    #expect(lb.switchDetail == "The token was revoked")
    api.on(.put, "/api/settings/listenbrainz", on)
    await lb.setEnabled(false)
    #expect(api.bodies(.put, "/api/settings/listenbrainz") == [#"{"enabled":false}"#])
    api.on(.post, "/api/settings/listenbrainz/earlier", on)
    await lb.sendEarlier()
    #expect(lb.notice == "Sending your earlier plays to ListenBrainz")
    api.on(.delete, "/api/settings/listenbrainz", ListenBrainzInfo(connected: false, enabled: false, pending: 0, sent: 0, earlier: 0))
    await lb.disconnect()
    #expect(lb.notice == "ListenBrainz disconnected" && lb.info?.connected == false)
  }

  @Test func refreshesListenBrainzEvery30Seconds() async {
    let clock = TestClock()
    let lb = ListenBrainzModel(api: api, clock: clock)
    api.on(.get, "/api/settings/listenbrainz", ListenBrainzInfo(connected: true, enabled: true, pending: 0, sent: 1, earlier: 0))
    let polling = Task { await lb.poll() }
    #expect(await clock.nextSleep() == .seconds(30))
    clock.advance(by: .seconds(30))
    #expect(await clock.nextSleep() == .seconds(30))
    #expect(api.calls(.get, "/api/settings/listenbrainz").count == 2)
    polling.cancel()
  }
}
