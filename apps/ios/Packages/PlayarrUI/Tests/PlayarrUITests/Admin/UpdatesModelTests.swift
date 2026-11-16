import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct UpdatesModelTests {
  let api = FakeAPI()
  let clock = TestClock()
  let now = Date(timeIntervalSince1970: 1_800_000_000)

  func info(state: String = "idle", requested: Bool = false, lastCheck: Int = 1_800_000_000 - 120, lastUpdate: Int = 0, available: Bool = true, reason: String? = nil) -> String {
    #"{"enabled":true,"intervalMinutes":60,"available":\#(available),"requested":\#(requested),\#(reason.map { #""reason":"\#($0)","# } ?? "")"status":{"state":"\#(state)","lastCheck":\#(lastCheck),"lastUpdate":\#(lastUpdate),"deployed":"1a2b3c4d5e","latest":"9f8e7d6c5b"},"log":"Pulling main"}"#
  }

  func model() -> UpdatesModel {
    api.on(.get, "/api/server", json: #"{"id":"srv","name":"NAS","version":"0.7.3","minAppVersion":"1.0.0","setup":false}"#)
    return UpdatesModel(api: api, clock: clock)
  }

  @Test func saysWhenTheRunningVersionWasInstalledAndWhenTheNewestCameOut() async {
    let updates = model()
    api.on(.get, "/api/settings/updates", json: #"{"enabled":true,"intervalMinutes":60,"available":true,"requested":false,"channel":"stable","status":{"state":"idle","lastCheck":1799999940,"lastUpdate":0,"deployed":"1a2b3c4d5e","latest":"9f8e7d6c5b","channel":"stable","release":"v0.7.0","deployedAt":1799992800,"latestAt":1799740800}}"#)
    await updates.load()
    #expect(updates.installedText(now: now) == "Installed 2 hours ago")
    #expect(updates.latestText(now: now) == "Latest release: v0.7.0 · 9f8e7d6, 3 days ago · A newer version is available")
    api.on(.get, "/api/settings/updates", json: info())
    await updates.load()
    #expect(updates.installedText(now: now) == nil)
    #expect(updates.latestText(now: now) == "Latest on main: 9f8e7d6 · A newer version is available")
  }

  @Test func saysTheVersionAndTheLastCheck() async {
    let updates = model()
    api.on(.get, "/api/settings/updates", json: info())
    await updates.load()
    #expect(updates.versionText == "Playarr v0.7.3 · 1a2b3c4")
    #expect(updates.latestText(now: now) == "Latest on main: 9f8e7d6 · A newer version is available")
    #expect(updates.lastCheck(now: now) == ("2 minutes ago · Already up to date", false))
    api.on(.get, "/api/settings/updates", json: info(lastCheck: 1_800_000_000 - 120, lastUpdate: 1_800_000_000 - 120))
    await updates.load()
    #expect(updates.lastCheck(now: now).text == "2 minutes ago · Updated to 1a2b3c4")
  }

  @Test func checksNowAndPollsQuicklyUntilTheUpdaterIsDone() async {
    let updates = model()
    api.on(.get, "/api/settings/updates", json: info())
    let polling = Task { await updates.poll() }
    #expect(await clock.nextSleep() == .seconds(60))
    api.on(.post, "/api/settings/updates/check", json: info(requested: true))
    await updates.checkNow()
    #expect(updates.busy && updates.checkLabel == "Checking…")
    polling.cancel()
    api.on(.get, "/api/settings/updates", json: info(state: "checking"))
    api.then(.get, "/api/settings/updates", json: info(state: "failed"))
    let again = Task { await updates.poll() }
    #expect(await clock.nextSleep() == .seconds(5))
    #expect(updates.lastCheck(now: now).text == "Checking for a new version…")
    clock.advance(by: .seconds(5))
    #expect(await clock.nextSleep() == .seconds(60))
    #expect(updates.lastCheck(now: now) == ("2 minutes ago · The update failed", true))
    again.cancel()
  }

  @Test func savesTheScheduleAndPutsItBackOnFailure() async {
    let updates = model()
    api.on(.get, "/api/settings/updates", json: info())
    await updates.load()
    api.fail(.put, "/api/settings/updates", status: 503, "The updater isn’t running")
    await updates.setInterval(1440)
    #expect(api.bodies(.put, "/api/settings/updates") == [#"{"intervalMinutes":1440}"#])
    #expect(updates.info?.intervalMinutes == 60)
    #expect(updates.notice == "Couldn’t save: The updater isn’t running")
  }

  @Test func choosesTheChannelAndSaysWhatTheLastCheckFound() async {
    let updates = model()
    let lastCheck = 1_800_000_000 - 120
    func found(_ channel: String, _ status: String) -> String {
      #"{"enabled":true,"intervalMinutes":15,"channel":"\#(channel)","available":true,"requested":false,"status":{"lastCheck":\#(lastCheck),"lastUpdate":0,"deployed":"1a2b3c4d5e",\#(status)}}"#
    }
    api.on(.get, "/api/settings/updates", json: found("edge", #""state":"idle","latest":"9f8e7d6c5b","channel":"edge","outcome":"waiting""#))
    await updates.load()
    #expect(updates.lastCheck(now: now) == ("2 minutes ago · 9f8e7d6 is waiting for its checks on GitHub", false))
    #expect(updates.latestText(now: now) == "Latest on main: 9f8e7d6 · Waiting for its checks")

    api.on(.put, "/api/settings/updates", json: found("stable", #""state":"idle","channel":"stable","outcome":"noRelease""#))
    await updates.setChannel(.stable)
    #expect(api.bodies(.put, "/api/settings/updates") == [#"{"channel":"stable"}"#])
    #expect(updates.info?.channel == .stable)
    #expect(updates.lastCheck(now: now) == ("2 minutes ago · No release yet: Playarr stays on this version until the first one", false))
    #expect(updates.latestText(now: now) == "Latest release: none yet")

    let error = "v0.7.0 (9f8e7d6) didn't start, so Playarr went back to 1a2b3c4 (rolled back)"
    api.on(
      .get, "/api/settings/updates",
      json: found("stable", #""state":"failed","latest":"9f8e7d6c5b","channel":"stable","release":"v0.7.0","outcome":"rolledBack","error":"\#(error)""#)
    )
    await updates.load()
    #expect(updates.lastCheck(now: now) == ("2 minutes ago · \(error)", true))
    #expect(updates.latestText(now: now) == "Latest release: v0.7.0 · 9f8e7d6 · It didn’t start")
  }

  @Test func explainsHowToStartTheUpdater() async {
    let updates = model()
    api.on(.get, "/api/settings/updates", json: info(available: false, reason: "Run update.sh once to start the updater"))
    await updates.load()
    #expect(updates.unavailable?.command == "sudo sh update.sh")
    api.on(.get, "/api/settings/updates", json: info(available: false, reason: "Not a Docker install"))
    await updates.load()
    #expect(updates.unavailable?.text == "Not a Docker install.")
  }
}
