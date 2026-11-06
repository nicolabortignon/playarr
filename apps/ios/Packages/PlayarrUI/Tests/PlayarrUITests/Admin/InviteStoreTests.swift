import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

/// The invites made on this device, as the web's (apps/web/src/lib/invites.test.ts): kept for each account of the
/// server until they expire, so Copy invite link can copy one again.
@MainActor @Suite struct InviteStoreTests {
  nonisolated static let now = Date(timeIntervalSince1970: 1_793_959_200)  // 2026-11-06T10:00:00Z

  private func setup(_ code: String, days: Double) -> SetupCode {
    let expires = Self.now.addingTimeInterval(days * 86_400)
    return SetupCode(code: code, link: "http://nas:4000/redeem?code=\(code)", expiresAt: ISO8601DateFormatter().string(from: expires))
  }

  private func file() -> URL {
    FileManager.default.temporaryDirectory.appending(path: "playarr-invites-\(UUID().uuidString)/invites.json")
  }

  @Test func keepsTheNewestCodeForEachAccountToCopyAgainWhileItWorks() {
    let invites = InviteStore(file: file(), now: { Self.now })
    invites.remember(setup("AAAA2222", days: 7), for: 3)
    invites.remember(setup("BBBB3333", days: 7), for: 3)
    invites.remember(setup("CCCC4444", days: 7), for: 4)
    #expect(invites.invite(for: 3)?.code == "BBBB3333")
    #expect(invites.invite(for: 4)?.link == "http://nas:4000/redeem?code=CCCC4444")
  }

  @Test func hasNoneOnceItHasExpiredOrForAnAccountInvitedElsewhere() {
    var now = Self.now
    let invites = InviteStore(file: file(), now: { now })
    invites.remember(setup("AAAA2222", days: 7), for: 3)
    #expect(invites.invite(for: 5) == nil)
    now = Self.now.addingTimeInterval(8 * 86_400)
    #expect(invites.invite(for: 3) == nil)
  }

  @Test func keepsThemOnThisDeviceForTheNextVisit() {
    let saved = file()
    InviteStore(file: saved, now: { Self.now }).remember(setup("AAAA2222", days: 7), for: 3)
    #expect(InviteStore(file: saved, now: { Self.now }).invite(for: 3)?.code == "AAAA2222")
    #expect(InviteStore.file(serverId: "nas").path().hasSuffix("Playarr/nas/invites.json"))
  }

  @Test func forgetsAnAccountsInviteAndSurvivesAFileItCantRead() throws {
    let saved = file()
    let invites = InviteStore(file: saved, now: { Self.now })
    invites.remember(setup("AAAA2222", days: 7), for: 3)
    invites.forget(3)
    #expect(invites.invite(for: 3) == nil)
    try Data("not json".utf8).write(to: saved)
    #expect(invites.invite(for: 3) == nil)
  }
}
