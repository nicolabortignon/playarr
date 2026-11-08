import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct AwayFromHomeModelTests {
  let api = FakeAPI()

  /// The server's answer when its router doesn't loop back (the server's own words).
  let unconfirmed = #"""
    {"verdict":"unconfirmed","summary":"This server couldn’t confirm it from inside your home: open https://music.example.com on a phone on mobile data to be sure.","publicUrl":"https://music.example.com","checkedAt":"2026-11-07T18:30:00.000Z","steps":[{"id":"address","label":"Public address","status":"ok","detail":"https://music.example.com"},{"id":"dns","label":"Name lookup","status":"ok","detail":"music.example.com is 203.0.113.7."},{"id":"connect","label":"Connection","status":"fail","detail":"No answer from 203.0.113.7 on port 443 within 5 s.","fix":"Open https://music.example.com on a phone on mobile data, Wi-Fi off, to be sure."},{"id":"certificate","label":"Certificate","status":"skipped"},{"id":"playarr","label":"This server answers","status":"skipped"}]}
    """#

  func server(publicUrl: String?) -> String {
    #"{"id":"srv","name":"NAS","version":"0.7.3","minAppVersion":"1.0.0","setup":false\#(publicUrl.map { #","publicUrl":"\#($0)""# } ?? "")}"#
  }

  @Test func showsThePublicAddressBeforeAnyCheck() async {
    api.on(.get, "/api/server", json: server(publicUrl: "https://music.example.com"))
    let model = AwayFromHomeModel(api: api)
    #expect(!model.addressKnown)
    await model.load()
    #expect(model.addressKnown && model.addressText == "https://music.example.com")
    #expect(model.result == nil && model.checkedText() == nil)
    // Asking the server to knock on its own door waits for Check now.
    #expect(api.calls(.post, "/api/settings/reachability/check").isEmpty)

    api.on(.get, "/api/server", json: server(publicUrl: nil))
    let unset = AwayFromHomeModel(api: api)
    await unset.load()
    #expect(unset.addressKnown && unset.addressText == "Not set yet")
  }

  @Test func checksAndShowsEachStepWithWhatToFix() async throws {
    api.on(.get, "/api/server", json: server(publicUrl: nil))
    api.on(.post, "/api/settings/reachability/check", json: unconfirmed)
    let model = AwayFromHomeModel(api: api)
    await model.load()
    #expect(model.checkLabel == "Check now")
    await model.check()
    let result = try #require(model.result)
    #expect(result.verdict == .unconfirmed)
    #expect(result.steps.map(\.status) == [.ok, .ok, .fail, .skipped, .skipped])
    #expect(result.steps[2].fix?.contains("mobile data") == true)
    // The address the server checked, now that it said.
    #expect(model.addressText == "https://music.example.com")
    #expect(model.checkedText()?.hasPrefix("Checked ") == true)
    #expect(result.steps.map { AwayFromHomeModel.word($0.status) } == ["passed", "passed", "failed", "not checked", "not checked"])
    #expect(AwayFromHomeModel.symbol(result.verdict) == "exclamationmark.triangle")
  }

  @Test func saysWhyItCouldntCheck() async {
    api.fail(.post, "/api/settings/reachability/check", status: 403, "Only an admin can change this")
    let model = AwayFromHomeModel(api: api)
    await model.check()
    #expect(model.notice == "Couldn’t check: Only an admin can change this")
    #expect(model.result == nil && !model.checking)
  }

  @Test func readsAStatusOrVerdictItDoesntKnowAsNotChecked() throws {
    let step = try JSONDecoder().decode(ReachabilityStep.self, from: Data(#"{"id":"proxy","label":"Proxy","status":"later"}"#.utf8))
    #expect(AwayFromHomeModel.word(step.status) == "not checked")
    #expect(AwayFromHomeModel.symbol(ReachabilityVerdict(rawValue: "maybe")) == "exclamationmark.circle")
  }
}
