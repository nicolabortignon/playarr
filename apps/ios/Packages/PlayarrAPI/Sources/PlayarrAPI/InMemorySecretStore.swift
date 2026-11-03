import Synchronization

/// Tokens in memory, for tests and previews.
public final class InMemorySecretStore: SecretStore {
    private let tokens: Mutex<[String: String]>

    public init(_ tokens: [String: String] = [:]) {
        self.tokens = Mutex(tokens)
    }

    public func token(for key: String) throws -> String? {
        tokens.withLock { $0[key] }
    }

    public func setToken(_ token: String, for key: String) throws {
        tokens.withLock { $0[key] = token }
    }

    public func removeToken(for key: String) throws {
        _ = tokens.withLock { $0.removeValue(forKey: key) }
    }
}
