import Foundation

/// A server the app knows, with the accounts signed in to it. Saved as JSON (no secrets).
public struct ServerRecord: Codable, Hashable, Sendable, Identifiable {
    /// The server's UUID (GET /api/server), stable across addresses.
    public var id: String
    public var name: String
    public var baseURL: URL
    public var accounts: [AccountRecord]

    public init(id: String, name: String, baseURL: URL, accounts: [AccountRecord] = []) {
        self.id = id
        self.name = name
        self.baseURL = baseURL
        self.accounts = accounts
    }
}
