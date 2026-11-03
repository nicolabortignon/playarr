import Foundation
import Security

/// Tokens in the Keychain: generic passwords under the app's bundle id, one per server and account
/// ("<serverId>:<accountId>"), readable after the first unlock so playback and downloads keep working
/// while the phone is locked.
public struct KeychainSecretStore: SecretStore {
    public static let service = "me.tracklistme.playarr"

    public init() {}

    public func token(for key: String) throws -> String? {
        var query = Self.query(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw KeychainError(status: status) }
        return String(decoding: data, as: UTF8.self)
    }

    public func setToken(_ token: String, for key: String) throws {
        let values: [String: Any] = [
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemUpdate(Self.query(key) as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            let added = SecItemAdd(Self.query(key).merging(values) { $1 } as CFDictionary, nil)
            guard added == errSecSuccess else { throw KeychainError(status: added) }
        } else if status != errSecSuccess {
            throw KeychainError(status: status)
        }
    }

    public func removeToken(for key: String) throws {
        let status = SecItemDelete(Self.query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }

    private static func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}

public struct KeychainError: Error, Equatable, Sendable {
    public let status: OSStatus
}
