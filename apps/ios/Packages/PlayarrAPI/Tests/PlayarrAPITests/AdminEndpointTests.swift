import Foundation
import Testing
@testable import PlayarrAPI

/// What Settings → Accounts and the other admin panels need from PlayarrAPI beyond phase 2.
@Suite struct AdminEndpointTests {
  @Test func changesAUsername() throws {
    let data = try #require(try API.Accounts.update(id: 2, AccountPatch(username: "samantha")).bodyData())
    let sent = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(sent.keys.sorted() == ["username"])
    #expect(sent["username"] as? String == "samantha")
  }
}
