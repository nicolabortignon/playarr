/// Where session tokens are kept: the Keychain in the app, memory in tests and previews.
public protocol SecretStore: Sendable {
    func token(for key: String) throws -> String?
    func setToken(_ token: String, for key: String) throws
    func removeToken(for key: String) throws
}
