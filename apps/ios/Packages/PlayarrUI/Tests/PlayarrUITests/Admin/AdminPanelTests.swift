import PlayarrAPI
import Testing
@testable import PlayarrUI

/// Settings' groups, as the web's (pages/Settings.tsx `useSettingsGroups`; docs/design.md, "Patterns").
@Suite struct AdminPanelTests {
  private func titles(_ groups: [SettingsGroup]) -> [String] { groups.map(\.title) }

  @Test func showsAnAdminThisDeviceThenTheServerInTheWebsOrder() {
    let groups = SettingsGroup.groups(for: .admin)
    #expect(titles(groups) == ["This device", "Server"])
    #expect(groups[0].panels == [.playback, .appearance])
    #expect(groups[0].note == "These settings are for this device.")
    #expect(groups[1].panels.map(\.title) == ["Sources", "Accounts", "Made for you", "Analysis", "Requests", "Updates"])
    #expect(groups[1].note == "These settings apply to everyone.")
  }

  @Test func showsAMemberTheirAccountBeforeTheServerWhichOnlyAnAdminChanges() {
    let groups = SettingsGroup.groups(for: .member)
    #expect(titles(groups) == ["This device", "Your account", "Server"])
    #expect(groups[1].panels == [.accounts, .mixes])
    #expect(groups[1].note == nil)
    #expect(groups[2].panels == [.sources, .analysis, .requests, .updates])
    #expect(groups[2].note == "Only an admin can change these.")
  }

  @Test func listsEveryPanelOnceAndYourListeningNowhere() {
    // Your listening is a place, in Library and the account menu: it isn't a setting.
    for role in [AccountRole.admin, .member] {
      let panels = SettingsGroup.groups(for: role).flatMap(\.panels)
      #expect(Set(panels).count == panels.count)
      #expect(Set(panels) == [.playback, .appearance, .sources, .accounts, .mixes, .analysis, .requests, .updates])
    }
  }
}
