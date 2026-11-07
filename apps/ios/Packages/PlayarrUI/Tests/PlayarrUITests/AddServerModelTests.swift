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
        let store = ServerStore(directory: directory, secrets: InMemorySecretStore(), session: session, network: LocalNetwork(isLocal: true))
        return AppModel(store: store, browser: ServerBrowser(), appVersion: AppVersion("1.0.0"), device: DeviceInfo(name: "Test", platform: "ios"))
    }

    @Test func offersTheDemoUntilThereIsAServerAndLeavesNothingOfIt() async throws {
        let app = app()
        let model = AddServerModel(app: app)
        #expect(model.offersTrial)

        model.tryWithoutServer()
        let trial = try #require(app.trial)
        #expect(trial.isTrial)
        #expect(trial.session?.account == Demo.account)
        // The demo is its own: nothing of it lands in this app's servers.
        #expect(app.store.servers.isEmpty)

        // A setting changed in the demo, and the queue it saves on leaving: both thrown away with it.
        let scratch = try #require(trial.scratch)
        trial.playback.transitions = .dj
        #expect(UserDefaults.standard.persistentDomain(forName: scratch.defaults)?.isEmpty == false)

        trial.leavesTrial?()
        #expect(app.trial == nil)
        #expect(!app.isTrial)
        #expect(!FileManager.default.fileExists(atPath: scratch.folder.path))
        #expect(UserDefaults.standard.persistentDomain(forName: scratch.defaults)?.isEmpty ?? true)
        #expect(app.playback.transitions != .dj)

        // An invite opened in the demo leaves it for the invite's server.
        app.tryWithoutServer()
        app.open(URL(string: "playarr://redeem?server=http%3A%2F%2F\(host)&code=ABCD-EFGH")!)
        #expect(app.trial == nil)
        #expect(app.redeemLink != nil)
        app.redeemLink = nil

        // Adding a server from Accounts, with one already here: no "New to Playarr?".
        #expect(await model.connect(to: URL(string: "http://\(host)")!))
        #expect(await model.signIn(username: "sam", password: "correct horse"))
        #expect(!model.offersTrial)
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
        // The owner's session opens on their first steps.
        #expect(app.opensFirstSteps)
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
        // The server at its new address, which proves it holds Sam's session ("tok") before it's taken for the server.
        let movedHost = "moved-\(UUID().uuidString.lowercased()).invalid"
        _ = FakeServer.session(host: movedHost) { FakeServer.proof($0, holding: ["tok"]) ?? (404, #"{"error":"Not found"}"#) }
        let moved = URL(string: "http://\(movedHost):4000")!

        app.browser.onUpdate?([DiscoveredServer(id: "srv-1", name: "Home", version: "0.7.0", baseURL: moved)])

        await eventually { app.store.activeServer?.localURL == moved }
        #expect(app.store.activeServer?.localURL == moved)
    }
}
