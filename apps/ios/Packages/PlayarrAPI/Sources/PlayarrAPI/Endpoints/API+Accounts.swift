extension API {
    /// Settings → Accounts (admin; an account may rename itself and see its own sessions).
    public enum Accounts {
        public static func list() -> Endpoint<[Account]> { Endpoint(.get, "/api/accounts") }

        /// A new account and its one-time setup code. `sources` nil: every source.
        public static func create(username: String, name: String, role: AccountRole, canRequest: Bool, sources: [Int]?) -> Endpoint<CreatedAccount> {
            Endpoint(.post, "/api/accounts", body: CreateBody(username: username, name: name, role: role, canRequest: canRequest, sources: sources))
        }

        public static func update(id: Int, _ patch: AccountPatch) -> Endpoint<Account> { Endpoint(.patch, "/api/accounts/\(id)", body: patch) }

        /// The accounts left (the last admin can't be deleted).
        public static func delete(id: Int) -> Endpoint<[Account]> { Endpoint(.delete, "/api/accounts/\(id)") }

        /// A new setup code; every session of the account is signed out.
        public static func reset(id: Int) -> Endpoint<SetupCode> { Endpoint(.post, "/api/accounts/\(id)/reset") }

        public static func sessions(accountId: Int) -> Endpoint<[SessionInfo]> { Endpoint(.get, "/api/accounts/\(accountId)/sessions") }

        /// The sessions left.
        public static func endSession(accountId: Int, sessionId: Int) -> Endpoint<[SessionInfo]> {
            Endpoint(.delete, "/api/accounts/\(accountId)/sessions/\(sessionId)")
        }

        private struct CreateBody: Encodable, Sendable {
            let username, name: String
            let role: AccountRole
            let canRequest: Bool
            let sources: [Int]?

            func encode(to encoder: any Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(username, forKey: .username)
                try container.encode(name, forKey: .name)
                try container.encode(role, forKey: .role)
                try container.encode(canRequest, forKey: .canRequest)
                try container.encode(sources, forKey: .sources) // null: every source
            }

            private enum CodingKeys: String, CodingKey { case username, name, role, canRequest, sources }
        }
    }
}

/// PATCH /api/accounts/:id: only the fields set are changed. `sources: .some(nil)` gives every source.
public struct AccountPatch: Encodable, Sendable, Equatable {
    public var name: String?
    public var role: AccountRole?
    public var canRequest: Bool?
    public var sources: [Int]??

    public init(name: String? = nil, role: AccountRole? = nil, canRequest: Bool? = nil, sources: [Int]?? = nil) {
        self.name = name
        self.role = role
        self.canRequest = canRequest
        self.sources = sources
    }
}
