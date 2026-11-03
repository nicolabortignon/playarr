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
}
