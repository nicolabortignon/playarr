import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrUI

/// Answers every request from one handler (each test has its own session and host).
final class FakeServer: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) -> (Int, String)
    private static let handlers = Mutex<[String: Handler]>([:])

    static func session(host: String, _ handler: @escaping Handler) -> URLSession {
        handlers.withLock { $0[host] = handler }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FakeServer.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let url = request.url!
        let (status, body) = Self.handlers.withLock { $0[url.host() ?? ""] }!(request)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor @Suite struct AddServerModelTests {
    let host = "test-\(UUID().uuidString.lowercased()).invalid"

    func app(setup: Bool = false, minAppVersion: String = "1.0.0") -> AppModel {
        let session = FakeServer.session(host: host) { request in
            switch request.url?.path() {
            case "/api/server": (200, #"{"id":"srv-1","name":"Home","version":"0.7.0","minAppVersion":"\#(minAppVersion)","setup":\#(setup)}"#)
            case "/api/auth/sign-in": (200, #"{"token":"tok","account":{"id":2,"username":"sam","name":"Sam","role":"member","canRequest":false,"sources":null,"hasPassword":true}}"#)
            default: (404, #"{"error":"Not found"}"#)
            }
        }
        let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)")
        let store = ServerStore(directory: directory, secrets: InMemorySecretStore(), session: session)
        return AppModel(store: store, browser: ServerBrowser(), appVersion: AppVersion("1.0.0"), device: DeviceInfo(name: "Test", platform: "ios"))
    }

    @Test func goesToSignInForAServerInUse() async {
        let model = AddServerModel(app: app())
        #expect(await model.connect(to: URL(string: "http://\(host)")!))
        #expect(model.nextStep == .signIn)
    }

    @Test func goesToSetupForAServerNoOneOwns() async {
        let model = AddServerModel(app: app(setup: true))
        await model.connect(to: URL(string: "http://\(host)")!)
        #expect(model.nextStep == .setup)
    }

    @Test func asksForAnUpdateWhenTheAppIsTooOld() async {
        let model = AddServerModel(app: app(minAppVersion: "2.0.0"))
        await model.connect(to: URL(string: "http://\(host)")!)
        #expect(model.nextStep == .tooOld)
    }

    @Test func explainsAnAddressThatIsntHTTPS() async {
        let model = AddServerModel(app: app())
        model.address = "http://music.example.com"
        #expect(await model.connect() == false)
        #expect(model.error == "Use https:// for a server outside your home network.")
    }

    @Test func signsInAndMakesTheAccountActive() async {
        let app = app()
        let model = AddServerModel(app: app)
        await model.connect(to: URL(string: "http://\(host)")!)
        #expect(await model.signIn(username: " sam ", password: "secret"))
        #expect(app.store.activeAccount?.account.name == "Sam")
        #expect(app.store.activeServer?.name == "Home")
    }
}
