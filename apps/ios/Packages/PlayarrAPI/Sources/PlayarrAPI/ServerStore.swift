import Foundation
import Observation

/// The servers the app knows, their signed-in accounts and which one is active. Servers are saved as
/// JSON in Application Support; tokens are in the SecretStore (the Keychain).
@MainActor @Observable
public final class ServerStore {
    public private(set) var servers: [ServerRecord] = []
    public private(set) var active: AccountKey?

    @ObservationIgnored private let file: URL
    @ObservationIgnored private let secrets: any SecretStore
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private var clients: [AccountKey: APIClient] = [:]

    public init(directory: URL, secrets: any SecretStore, session: URLSession = .shared) {
        self.file = directory.appending(path: "servers.json")
        self.secrets = secrets
        self.session = session
        if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Saved.self, from: data) {
            servers = saved.servers
            active = saved.active
        }
    }

    /// The app's store: Application Support/Playarr/servers.json and the Keychain.
    public static func live() -> ServerStore {
        ServerStore(directory: .applicationSupportDirectory.appending(path: "Playarr", directoryHint: .isDirectory), secrets: KeychainSecretStore())
    }

    public var activeServer: ServerRecord? { active.flatMap { server($0.serverId) } }
    public var activeAccount: AccountRecord? { active.flatMap(account) }
    /// The active account's client; nil when there is none or it is signed out.
    public var activeClient: APIClient? { activeAccount.flatMap(client) }

    public func server(_ id: String) -> ServerRecord? { servers.first { $0.id == id } }

    public func account(_ key: AccountKey) -> AccountRecord? {
        server(key.serverId)?.accounts.first { $0.account.id == key.accountId }
    }

    /// A client for a signed-in account (one per account, kept); nil when signed out.
    public func client(for record: AccountRecord) -> APIClient? {
        let key = record.key
        if let client = clients[key] { return client }
        guard record.signedIn, let server = server(key.serverId), let token = try? secrets.token(for: key.keychainAccount) else { return nil }
        let client = APIClient(baseURL: server.baseURL, localURL: server.localURL, token: token, session: session) { [weak self] in
            await self?.markSignedOut(key)
        }
        clients[key] = client
        return client
    }

    /// A client that signs in nobody: GET /api/server and the sign-in calls.
    public func anonymousClient(for baseURL: URL) -> APIClient {
        APIClient(baseURL: baseURL, session: session, timeout: 15)
    }

    /// The same for a known server, trying its local address too.
    public func anonymousClient(for server: ServerRecord) -> APIClient {
        APIClient(baseURL: server.baseURL, localURL: server.localURL, session: session, timeout: 15)
    }

    /// Media addresses for a signed-in account, with its token for the Authorization header.
    public func mediaURLs(for record: AccountRecord) -> MediaURLs? {
        guard record.signedIn, let server = server(record.serverId), let token = try? secrets.token(for: record.key.keychainAccount) else { return nil }
        return MediaURLs(baseURL: server.baseURL, localURL: server.localURL, token: token)
    }

    /// Remembers a server reached at `url`, or its new name and address. A server with a public address
    /// (`publicUrl`, HTTPS or at home) is kept by it, and `url`, when it's another address, becomes its local
    /// one; reached at its public (or only) address, the local address known before is kept.
    @discardableResult
    public func remember(_ info: ServerInfo, at url: URL) -> ServerRecord {
        let baseURL = info.publicUrl.flatMap { try? ServerAddress.url(from: $0) } ?? url
        let index = servers.firstIndex { $0.id == info.id }
        let localURL = Self.sameAddress(url, baseURL) ? index.flatMap { servers[$0].localURL } : url
        guard let index else {
            let record = ServerRecord(id: info.id, name: info.name, baseURL: baseURL, localURL: localURL)
            servers.append(record)
            save()
            return record
        }
        if servers[index].baseURL != baseURL || servers[index].localURL != localURL { dropClients(serverId: info.id) }
        servers[index].name = info.name
        servers[index].baseURL = baseURL
        servers[index].localURL = localURL
        save()
        return servers[index]
    }

    /// Servers Bonjour found: a known one at another address than its own keeps that as its local address.
    public func discovered(_ found: [DiscoveredServer]) {
        var changed = false
        for server in found {
            guard let index = servers.firstIndex(where: { $0.id == server.id }),
                  !Self.sameAddress(server.baseURL, servers[index].baseURL),
                  servers[index].localURL != server.baseURL
            else { continue }
            servers[index].localURL = server.baseURL
            dropClients(serverId: server.id)
            changed = true
        }
        if changed { save() }
    }

    private static func sameAddress(_ a: URL, _ b: URL) -> Bool {
        func key(_ url: URL) -> String {
            var text = url.absoluteString.lowercased()
            while text.hasSuffix("/") { text.removeLast() }
            return text
        }
        return key(a) == key(b)
    }

    /// Keeps a new session (sign-in, setup code or claiming the server) and makes its account active.
    public func signedIn(_ response: SignInResponse, server info: ServerInfo, at baseURL: URL) throws {
        remember(info, at: baseURL)
        let record = AccountRecord(serverId: info.id, account: response.account)
        try secrets.setToken(response.token, for: record.key.keychainAccount)
        clients[record.key] = nil
        update(serverId: info.id) { server in
            if let index = server.accounts.firstIndex(where: { $0.account.id == record.account.id }) {
                server.accounts[index] = record
            } else {
                server.accounts.append(record)
            }
        }
        active = record.key
        save()
    }

    /// Switches to another account: no password, its token is already kept.
    public func activate(_ key: AccountKey) {
        guard account(key) != nil else { return }
        active = key
        save()
    }

    /// The account as the server describes it now (GET /api/auth/me).
    public func update(_ account: Account, on serverId: String) {
        update(serverId: serverId) { server in
            if let index = server.accounts.firstIndex(where: { $0.account.id == account.id }) { server.accounts[index].account = account }
        }
        save()
    }

    /// The server ended the session: forget the token, keep the account listed to sign in again.
    public func markSignedOut(_ key: AccountKey) {
        try? secrets.removeToken(for: key.keychainAccount)
        clients[key] = nil
        update(serverId: key.serverId) { server in
            if let index = server.accounts.firstIndex(where: { $0.account.id == key.accountId }) { server.accounts[index].signedIn = false }
        }
        save()
    }

    /// Signs out on the server (POST /api/auth/sign-out), forgets the token and the account, and the
    /// server too once no account is left. Another signed-in account becomes active, if there is one.
    public func signOut(_ key: AccountKey) async {
        if let record = account(key), let client = client(for: record) {
            _ = try? await client.send(API.Auth.signOut())
        }
        try? secrets.removeToken(for: key.keychainAccount)
        clients[key] = nil
        update(serverId: key.serverId) { server in server.accounts.removeAll { $0.account.id == key.accountId } }
        servers.removeAll { $0.accounts.isEmpty && $0.id == key.serverId }
        if active == key {
            active = servers.lazy.flatMap(\.accounts).first(where: \.signedIn)?.key
        }
        save()
    }

    private func update(serverId: String, _ change: (inout ServerRecord) -> Void) {
        guard let index = servers.firstIndex(where: { $0.id == serverId }) else { return }
        change(&servers[index])
    }

    private func dropClients(serverId: String) {
        clients = clients.filter { $0.key.serverId != serverId }
    }

    private struct Saved: Codable {
        var servers: [ServerRecord]
        var active: AccountKey?
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(Saved(servers: servers, active: active)).write(to: file, options: .atomic)
        } catch {
            assertionFailure("Saving the server list failed: \(error)")
        }
    }
}
