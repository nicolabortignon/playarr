import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrUI

@MainActor @Suite struct AddServerModelTests {
    let host = "test-\(UUID().uuidString.lowercased()).invalid"

    func app(setup: Bool = false, minAppVersion: String = "1.0.0", publicUrl: String? = nil) -> AppModel {
        let publicField = publicUrl.map { #","publicUrl":"\#($0)""# } ?? ""
        let session = FakeServer.session(host: host) { request in
            switch request.url?.path() {
            case "/api/server": (200, #"{"id":"srv-1","name":"Home","version":"0.7.0","minAppVersion":"\#(minAppVersion)","setup":\#(setup)\#(publicField)}"#)
            case "/api/auth/sign-in": (200, #"{"token":"tok","account":{"id":2,"username":"sam","name":"Sam","role":"member","canRequest":false,"sources":null,"hasPassword":true}}"#)
            case "/api/auth/setup": (200, #"{"token":"tok","account":{"id":1,"username":"nicola","name":"Nicola","role":"admin","canRequest":true,"sources":null,"hasPassword":true}}"#)
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

    @Test func claimsAtHomeThenKeepsTheServerByItsPublicAddress() async {
        let app = app(setup: true, publicUrl: "https://tracklist.me")
        let model = AddServerModel(app: app)
        let local = URL(string: "http://\(host):4000")!
        await model.connect(to: local)
        #expect(model.nextStep == .setup)
        // The claim goes to the local address (setup works only from the home network): the fake server
        // answers only there, so this would fail anywhere else.
        #expect(await model.claim(username: "nicola", name: "Nicola", password: "correct horse"))
        #expect(app.store.activeServer?.baseURL == URL(string: "https://tracklist.me")!)
        #expect(app.store.activeServer?.localURL == local)
        #expect(app.store.activeClient?.localURL == local)
    }

    @Test func signsInAtHomeThenKeepsTheServerByItsPublicAddress() async {
        let app = app(publicUrl: "https://tracklist.me")
        let model = AddServerModel(app: app)
        let local = URL(string: "http://\(host)")!
        await model.connect(to: local)
        #expect(await model.signIn(username: "sam", password: "secret"))
        #expect(app.store.activeServer?.baseURL == URL(string: "https://tracklist.me")!)
        #expect(app.store.activeServer?.localURL == local)
    }

    @Test func bonjourKeepsAKnownServersLocalAddressUpToDate() async {
        let app = app(publicUrl: "https://tracklist.me")
        let model = AddServerModel(app: app)
        await model.connect(to: URL(string: "http://\(host)")!)
        _ = await model.signIn(username: "sam", password: "secret")
        let moved = URL(string: "http://192.168.1.50:4000")!

        app.browser.onUpdate?([DiscoveredServer(id: "srv-1", name: "Home", version: "0.7.0", baseURL: moved)])

        #expect(app.store.activeServer?.localURL == moved)
    }
}
