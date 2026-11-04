import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct AdminPanelTests {
  @Test func showsAdminsEveryServerPanelInTheWebsOrder() {
    #expect(SettingsPanel.server(for: .admin).map(\.title) == ["Sources", "Accounts", "Mixes", "Analysis", "Requests", "Updates"])
  }

  @Test func showsMembersOnlyTheirOwnBits() {
    #expect(SettingsPanel.server(for: .member) == [.accounts, .mixes])
  }
}
