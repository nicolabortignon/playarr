import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrUI

@MainActor @Suite struct SignInTVModelTests {
  let host = "tv-\(UUID().uuidString.lowercased()).invalid"
  /// The same server at another address (its home address, say).
  let other = "tv-home-\(UUID().uuidString.lowercased()).invalid"
  /// Each request: "host path Authorization".
  let asked = Asked()

  final class Asked: Sendable {
    private let calls = Mutex<[String]>([])
    func add(_ call: String) { calls.withLock { $0.append(call) } }
    var all: [String] { calls.withLock { $0 } }
  }

  static let found = #"{"device":"Living room TV","platform":"tv","expiresAt":"2026-11-16T12:10:00.000Z"}"#

  /// An app signed in to `host` as Sam; `codes` is what the server answers for a TV's code.
  func app(codes: (Int, String) = (200, found)) async -> AppModel {
    let asked = asked
    let handler: FakeServer.Handler = { request in
      let path = request.url?.path() ?? ""
      asked.add("\(request.url?.host() ?? "") \(path) \(request.value(forHTTPHeaderField: "Authorization") ?? "")")
      switch path {
      case "/api/server": return (200, #"{"id":"srv-1","name":"Home","version":"0.7.0","minAppVersion":"1.0.0","setup":false}"#)
      case "/api/auth/sign-in":
        return (200, #"{"token":"tok","account":{"id":2,"username":"sam","name":"Sam","role":"member","canRequest":false,"sources":null,"hasPassword":true}}"#)
      case "/api/auth/device/lookup", "/api/auth/device/approve": return codes
      default: return (404, #"{"error":"Not found"}"#)
      }
    }
    let session = FakeServer.session(host: host, handler)
    _ = FakeServer.session(host: other, handler)
    let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)")
    let store = ServerStore(directory: directory, secrets: InMemorySecretStore(), session: session, network: LocalNetwork(isLocal: true))
    let app = AppModel(store: store, browser: ServerBrowser(), appVersion: AppVersion("1.0.0"), device: DeviceInfo(name: "Test", platform: "ios"))
    let add = AddServerModel(app: app)
    _ = await add.connect(to: URL(string: "http://\(host)")!)
    _ = await add.signIn(username: "sam", password: "correct horse")
    return app
  }

  func link(_ server: String) -> URL { URL(string: "playarr://link?server=http%3A%2F%2F\(server)&code=abcd-2345")! }

  func codeCalls() -> [String] { asked.all.filter { $0.contains("/api/auth/device/") } }

  @Test func signsTheTVInAsTheAccountSignedInHere() async throws {
    let app = await app()
    app.open(link(host))
    let model = SignInTVModel(app: app, link: try #require(app.deviceLink))
    await model.start()
    #expect(model.phase == .ready)
    #expect(model.device == "Living room TV")
    #expect(model.serverName == "Home")
    #expect(model.accounts.map(\.account.name) == ["Sam"])
    #expect(model.chosenAccount?.account.name == "Sam")

    await model.approve()
    #expect(model.phase == .done(account: "Sam"))
    #expect(codeCalls() == ["\(host) /api/auth/device/lookup Bearer tok", "\(host) /api/auth/device/approve Bearer tok"])
  }

  @Test func findsTheServerByWhoItIsAtAnotherAddressAndSendsTheTokenOnlyToTheOneItKnows() async throws {
    let app = await app()
    let model = SignInTVModel(app: app, link: try #require(DeviceLink(link(other))))
    await model.start()
    #expect(model.phase == .ready)
    let calls = asked.all
    #expect(calls.contains("\(other) /api/server "))
    #expect(!calls.contains { $0.hasPrefix(other) && $0.contains("Bearer") })
    #expect(codeCalls() == ["\(host) /api/auth/device/lookup Bearer tok"])
  }

  @Test func saysToSignInFirstOnAServerItDoesntKnow() async throws {
    let app = await app()
    let model = SignInTVModel(app: app, link: try #require(DeviceLink(link("nowhere-\(UUID().uuidString.lowercased()).invalid"))))
    await model.start()
    #expect(model.phase == .notSignedIn)
    #expect(model.link.webPage?.path() == "/link")
    #expect(codeCalls().isEmpty)
  }

  @Test func saysWhyTheServerRefusesTheCode() async throws {
    let app = await app(codes: (404, #"{"error":"That code is wrong, used or expired. Start again on the TV."}"#))
    let model = SignInTVModel(app: app, link: try #require(DeviceLink(link(host))))
    await model.start()
    #expect(model.phase == .failed("That code is wrong, used or expired. Start again on the TV."))
    await model.approve()
    #expect(codeCalls() == ["\(host) /api/auth/device/lookup Bearer tok"])
  }
}
