/// Which account on which server: how tokens, clients and the active choice are keyed.
public struct AccountKey: Codable, Hashable, Sendable {
    public var serverId: String
    public var accountId: Int

    public init(serverId: String, accountId: Int) {
        self.serverId = serverId
        self.accountId = accountId
    }

    /// The token's Keychain account.
    public var keychainAccount: String { "\(serverId):\(accountId)" }
}
