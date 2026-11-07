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
    @ObservationIgnored private let network: LocalNetwork
    @ObservationIgnored private var clients: [AccountKey: APIClient] = [:]
    /// Each signed-in account's view of its server's home address (what it proved on this network), shared by the
    /// account's client and media addresses.
    @ObservationIgnored private var homes: [AccountKey: HomeAddress] = [:]

    /// `network`: whether the phone is on a network where a home address may be tried (`LocalNetwork.shared`).
    public init(directory: URL, secrets: any SecretStore, session: URLSession = .shared, network: LocalNetwork = .shared) {
        self.file = directory.appending(path: "servers.json")
        self.secrets = secrets
        self.session = session
        self.network = network
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

    /// Whether the account's token is on this device: false when the Keychain has none (an unencrypted backup brings the
    /// server list back but leaves the Keychain out); throws when the Keychain can't be read now.
    public func hasToken(_ key: AccountKey) throws -> Bool {
        try secrets.token(for: key.keychainAccount) != nil
    }

    /// A client for a signed-in account (one per account, kept); nil when signed out.
    public func client(for record: AccountRecord) -> APIClient? {
        let key = record.key
        if let client = clients[key] { return client }
        guard record.signedIn, let server = server(key.serverId), let token = try? secrets.token(for: key.keychainAccount) else { return nil }
        let client = APIClient(baseURL: server.baseURL, home: home(of: server, for: key, token: token), token: token, session: session) { [weak self] in
            await self?.markSignedOut(key)
        }
        clients[key] = client
        return client
    }

    /// A client that signs in nobody: GET /api/server and the sign-in calls.
    public func anonymousClient(for baseURL: URL) -> APIClient {
        APIClient(baseURL: baseURL, session: session, timeout: 15)
    }

    /// The same for a known server, trying its home address too once the server there has proven itself to a signed-in
    /// account (preferably the active one): an answer from anything else at that address could steer the app anywhere
    /// (its `publicUrl`), token or not. Without a signed-in account, its public address only.
    public func anonymousClient(for server: ServerRecord) -> APIClient {
        let signedIn = server.accounts.filter(\.signedIn)
        var home: HomeAddress?
        for record in signedIn.filter({ $0.key == active }) + signedIn.filter({ $0.key != active }) {
            guard let token = try? secrets.token(for: record.key.keychainAccount) else { continue }
            home = self.home(of: server, for: record.key, token: token)
            break
        }
        return APIClient(baseURL: server.baseURL, home: home, session: session, timeout: 15)
    }

    /// Media addresses for a signed-in account, with its token for the Authorization header.
    public func mediaURLs(for record: AccountRecord) -> MediaURLs? {
        guard record.signedIn, let server = server(record.serverId), let token = try? secrets.token(for: record.key.keychainAccount) else { return nil }
        return MediaURLs(baseURL: server.baseURL, home: home(of: server, for: record.key, token: token), token: token)
    }

    /// The account's view of the server's home address, kept while the address stays the same; nil without one.
    private func home(of server: ServerRecord, for key: AccountKey, token: String) -> HomeAddress? {
        guard let localURL = server.localURL else { return nil }
        if let home = homes[key], home.url == localURL { return home }
        let home = HomeAddress(url: localURL, token: token, session: session, network: network)
        homes[key] = home
        return home
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

    /// Servers Bonjour found: a known one at another address than its own keeps that as its local address, once the
    /// server there has proven it holds a signed-in account's session (`HomeAddress`), since anything on a network can
    /// advertise `_playarr._tcp` with a server's id. A server with no account signed in has no use for one. Returns
    /// the checks, for tests to wait on.
    @discardableResult
    public func discovered(_ found: [DiscoveredServer]) -> Task<Void, Never> {
        var candidates: [(key: AccountKey, home: HomeAddress)] = []
        for server in found {
            guard let known = self.server(server.id), !Self.sameAddress(server.baseURL, known.baseURL), known.localURL != server.baseURL else { continue }
            for record in known.accounts where record.signedIn {
                guard let token = try? secrets.token(for: record.key.keychainAccount) else { continue }
                candidates.append((record.key, HomeAddress(url: server.baseURL, token: token, session: session, network: network)))
                break
            }
        }
        return Task { [weak self] in
            for candidate in candidates {
                if await candidate.home.verify() { self?.adopt(candidate.home, for: candidate.key) }
            }
        }
    }

    /// A home address Bonjour found and the server there proved to `key`'s session, which keeps the proof.
    private func adopt(_ home: HomeAddress, for key: AccountKey) {
        guard let index = servers.firstIndex(where: { $0.id == key.serverId }), servers[index].localURL != home.url else { return }
        servers[index].localURL = home.url
        dropClients(serverId: key.serverId)
        homes[key] = home
        save()
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
        homes[record.key] = nil
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
        homes[key] = nil
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
        homes[key] = nil
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
        homes = homes.filter { $0.key.serverId != serverId }
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
