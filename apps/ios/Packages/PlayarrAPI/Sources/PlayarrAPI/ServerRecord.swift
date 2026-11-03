import Foundation

/// A server the app knows, with the accounts signed in to it. Saved as JSON (no secrets).
public struct ServerRecord: Codable, Hashable, Sendable, Identifiable {
    /// The server's UUID (GET /api/server), stable across addresses.
    public var id: String
    public var name: String
    /// Where requests go: the server's public address (`ServerInfo.publicUrl`) when it has one.
    public var baseURL: URL
    /// The address it was reached at on the home network (Bonjour or typed), when that isn't `baseURL`:
    /// requests that can't connect to `baseURL` try it (routers without NAT loopback). Optional, so lists
    /// saved before it existed still load.
    public var localURL: URL?
    public var accounts: [AccountRecord]

    public init(id: String, name: String, baseURL: URL, localURL: URL? = nil, accounts: [AccountRecord] = []) {
        self.id = id
        self.name = name
        self.baseURL = baseURL
        self.localURL = localURL
        self.accounts = accounts
    }
}
