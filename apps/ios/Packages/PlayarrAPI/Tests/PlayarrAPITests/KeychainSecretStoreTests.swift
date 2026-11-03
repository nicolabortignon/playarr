import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct KeychainSecretStoreTests {
    @Test func savesReplacesAndRemovesAToken() throws {
        let store = KeychainSecretStore()
        let key = "test-\(UUID().uuidString):1"
        defer { try? store.removeToken(for: key) }

        #expect(try store.token(for: key) == nil)
        try store.setToken("first", for: key)
        try store.setToken("second", for: key)
        #expect(try store.token(for: key) == "second")
        try store.removeToken(for: key)
        #expect(try store.token(for: key) == nil)
    }
}
