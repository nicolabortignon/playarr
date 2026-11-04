import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct UITestSignInTests {
  let host = "uitest-\(UUID().uuidString.lowercased()).invalid"

  func app(_ session: URLSession) -> AppModel {
    let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)")
    let store = ServerStore(directory: directory, secrets: InMemorySecretStore(), session: session)
    return AppModel(store: store, browser: ServerBrowser(), appVersion: AppVersion("1.0.0"), device: DeviceInfo(name: "Test", platform: "ios"))
  }

  @Test func signsInWithTheTokenAUITestGives() async {
    let session = FakeServer.session(host: host) { request in
      switch request.url?.path() {
      case "/api/server": (200, #"{"id":"srv-1","name":"Dev","version":"0.7.0","minAppVersion":"1.0.0","setup":false}"#)
      case "/api/auth/me":
        request.value(forHTTPHeaderField: "Authorization") == "Bearer tok"
          ? (200, #"{"id":1,"username":"nicola","name":"Nicola","role":"admin","canRequest":true,"sources":null,"hasPassword":true}"#)
          : (401, #"{"error":"Sign in","setup":false}"#)
      default: (404, #"{"error":"Not found"}"#)
      }
    }
    let model = app(session)
    await model.signInForUITests(environment: [AppModel.uiTestServerKey: "http://\(host)", AppModel.uiTestTokenKey: "tok"], session: session)
    #expect(model.store.activeAccount?.account.role == .admin)
    #expect(model.store.activeServer?.name == "Dev")
  }

  @Test func doesNothingWithoutTheKeys() async {
    let model = app(.shared)
    await model.signInForUITests(environment: [:])
    #expect(model.store.activeAccount == nil)
  }
}
