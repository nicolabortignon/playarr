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

  @Test func saysTheVersionAndTheLastCheck() async {
    let updates = model()
    api.on(.get, "/api/settings/updates", json: info())
    await updates.load()
    #expect(updates.versionText == "Playarr v0.7.3 · 1a2b3c4")
    #expect(updates.latestText == "Latest on GitHub: 9f8e7d6 · A newer version is available")
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
