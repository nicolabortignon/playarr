/// An account the app has signed in to on a server. Its token is in the SecretStore, never here.
public struct AccountRecord: Codable, Hashable, Sendable, Identifiable {
    public var serverId: String
    /// As the server last described it.
    public var account: Account
    /// False once the server ended the session (a 401): the account stays listed, to sign in again.
    public var signedIn: Bool

    public init(serverId: String, account: Account, signedIn: Bool = true) {
        self.serverId = serverId
        self.account = account
        self.signedIn = signedIn
    }

    public var key: AccountKey { AccountKey(serverId: serverId, accountId: account.id) }
    public var id: AccountKey { key }
}
