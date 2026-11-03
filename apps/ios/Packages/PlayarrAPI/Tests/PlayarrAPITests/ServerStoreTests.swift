import Foundation
import Testing
@testable import PlayarrAPI

@MainActor @Suite struct ServerStoreTests {
    let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)")
    let secrets = InMemorySecretStore()
    let home = ServerInfo(id: "srv-1", name: "Home", version: "0.7.0", minAppVersion: "1.0.0", setup: false)
    let homeURL = URL(string: "http://192.168.1.103:4000")!

    func account(_ id: Int, _ name: String) -> Account {
        Account(id: id, username: name.lowercased(), name: name, role: id == 1 ? .admin : .member, canRequest: true, sources: nil, hasPassword: true)
    }

    @Test func keepsTheTokenInTheSecretStoreAndTheRestOnDisk() throws {
        let store = ServerStore(directory: directory, secrets: secrets)
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: home, at: homeURL)

        #expect(try secrets.token(for: "srv-1:1") == "tok-1")
        let saved = try String(contentsOf: directory.appending(path: "servers.json"), encoding: .utf8)
        #expect(!saved.contains("tok-1"))

        let reopened = ServerStore(directory: directory, secrets: secrets)
        #expect(reopened.servers.map(\.name) == ["Home"])
        #expect(reopened.activeAccount?.account.name == "Nicola")
        #expect(reopened.activeClient != nil)
    }

    @Test func switchesAccountsWithoutAPassword() throws {
        let store = ServerStore(directory: directory, secrets: secrets)
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: home, at: homeURL)
        try store.signedIn(SignInResponse(token: "tok-2", account: account(2, "Sam")), server: home, at: homeURL)
        #expect(store.activeAccount?.account.name == "Sam")

        store.activate(AccountKey(serverId: "srv-1", accountId: 1))

        #expect(store.activeAccount?.account.name == "Nicola")
        #expect(ServerStore(directory: directory, secrets: secrets).active == AccountKey(serverId: "srv-1", accountId: 1))
    }

    @Test func keepsOneRecordPerServerAndFollowsItsNewAddress() throws {
        let store = ServerStore(directory: directory, secrets: secrets)
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: home, at: homeURL)
        let moved = URL(string: "https://music.example.com")!

        store.remember(ServerInfo(id: "srv-1", name: "Home NAS", version: "0.7.1", minAppVersion: "1.0.0", setup: false), at: moved)

        #expect(store.servers.count == 1)
        #expect(store.servers[0].name == "Home NAS")
        #expect(store.servers[0].baseURL == moved)
        #expect(store.activeClient?.baseURL == moved)
    }

    @Test func marksAnEndedSessionSignedOut() throws {
        let store = ServerStore(directory: directory, secrets: secrets)
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: home, at: homeURL)

        store.markSignedOut(AccountKey(serverId: "srv-1", accountId: 1))

        #expect(try secrets.token(for: "srv-1:1") == nil)
        #expect(store.activeAccount?.signedIn == false)
        #expect(store.activeClient == nil)
    }

    @Test func signsOutOnTheServerAndForgetsTheAccount() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { request in
            #expect(request.url?.path() == "/api/auth/sign-out")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok-2")
            return (204, Data())
        }
        let store = ServerStore(directory: directory, secrets: secrets, session: session)
        let url = URL(string: "http://\(host)")!
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: home, at: url)
        try store.signedIn(SignInResponse(token: "tok-2", account: account(2, "Sam")), server: home, at: url)

        await store.signOut(AccountKey(serverId: "srv-1", accountId: 2))

        #expect(try secrets.token(for: "srv-1:2") == nil)
        #expect(store.servers[0].accounts.map(\.account.name) == ["Nicola"])
        #expect(store.activeAccount?.account.name == "Nicola")
    }

    @Test func forgetsTheServerWithItsLastAccount() async throws {
        let store = ServerStore(directory: directory, secrets: secrets)
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: home, at: URL(string: "http://\(uniqueHost())")!)

        await store.signOut(AccountKey(serverId: "srv-1", accountId: 1))

        #expect(store.servers.isEmpty)
        #expect(store.active == nil)
    }

    @Test func endsTheSessionWhenTheServerAnswers401() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in (401, json(#"{"error":"Sign in"}"#)) }
        let store = ServerStore(directory: directory, secrets: secrets, session: session)
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: home, at: URL(string: "http://\(host)")!)

        let client = try #require(store.activeClient)
        await #expect(throws: APIError.unauthorized) { try await client.send(API.Auth.me()) }

        #expect(store.activeAccount?.signedIn == false)
        #expect(try secrets.token(for: "srv-1:1") == nil)
    }

    @Test func startsEmptyFromADamagedFile() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: directory.appending(path: "servers.json"))
        #expect(ServerStore(directory: directory, secrets: secrets).servers.isEmpty)
    }

    // A server with a public address (PUBLIC_URL), e.g. https://tracklist.me behind a reverse proxy.

    var tracklist: ServerInfo { ServerInfo(id: "srv-1", name: "Home", version: "0.7.0", minAppVersion: "1.0.0", setup: false, publicUrl: "https://tracklist.me") }
    let publicURL = URL(string: "https://tracklist.me")!

    @Test func keepsAServerByItsPublicAddressAndTheLocalOneItWasReachedAt() throws {
        let store = ServerStore(directory: directory, secrets: secrets)
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: tracklist, at: homeURL)

        #expect(store.servers[0].baseURL == publicURL)
        #expect(store.servers[0].localURL == homeURL)
        #expect(store.activeClient?.baseURL == publicURL)
        #expect(store.activeClient?.localURL == homeURL)
        let record = try #require(store.activeAccount)
        #expect(store.mediaURLs(for: record)?.baseURL == publicURL)
        #expect(store.anonymousClient(for: store.servers[0]).localURL == homeURL)

        let reopened = ServerStore(directory: directory, secrets: secrets)
        #expect(reopened.servers[0].baseURL == publicURL)
        #expect(reopened.servers[0].localURL == homeURL)
    }

    @Test func keepsTheLocalAddressWhenReachedAtThePublicOne() throws {
        let store = ServerStore(directory: directory, secrets: secrets)
        store.remember(tracklist, at: homeURL)
        store.remember(tracklist, at: publicURL)
        #expect(store.servers[0].baseURL == publicURL)
        #expect(store.servers[0].localURL == homeURL)

        let elsewhere = ServerStore(directory: directory.appending(path: "other"), secrets: secrets)
        elsewhere.remember(tracklist, at: URL(string: "https://tracklist.me/")!)
        #expect(elsewhere.servers[0].localURL == nil)
    }

    @Test func usesAPublicAddressOnlyOverHTTPSOrAtHome() {
        let store = ServerStore(directory: directory, secrets: secrets)
        var info = tracklist
        info.publicUrl = "http://tracklist.me"
        store.remember(info, at: homeURL)
        #expect(store.servers[0].baseURL == homeURL)
        #expect(store.servers[0].localURL == nil)
    }

    @Test func followsBonjourToTheServersLocalAddress() throws {
        let store = ServerStore(directory: directory, secrets: secrets)
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: tracklist, at: homeURL)
        let moved = URL(string: "http://192.168.1.50:4000")!

        store.discovered([
            DiscoveredServer(id: "srv-1", name: "Home", version: "0.7.0", baseURL: moved),
            DiscoveredServer(id: "srv-other", name: "Elsewhere", version: "0.7.0", baseURL: URL(string: "http://192.168.1.60:4000")!),
        ])

        #expect(store.servers.map(\.id) == ["srv-1"])
        #expect(store.servers[0].baseURL == publicURL)
        #expect(store.servers[0].localURL == moved)
        #expect(store.activeClient?.localURL == moved)
        #expect(ServerStore(directory: directory, secrets: secrets).servers[0].localURL == moved)
    }

    @Test func readsServerListsSavedBeforeLocalAddresses() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try json(#"{"servers":[{"id":"srv-1","name":"Home","baseURL":"http:\/\/192.168.1.103:4000","accounts":[]}]}"#).write(to: directory.appending(path: "servers.json"))
        let store = ServerStore(directory: directory, secrets: secrets)
        #expect(store.servers.first?.baseURL == homeURL)
        #expect(store.servers.first?.localURL == nil)
    }
}
