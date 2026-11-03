import Foundation
import Testing
@testable import PlayarrUI

@MainActor @Suite struct ThemeTests {
  func settings() -> AppearanceSettings { AppearanceSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!) }

  @Test func followsTheCoverUnlessAColourIsChosen() async {
    let appearance = settings()
    let theme = Theme(appearance: appearance)
    #expect(theme.accent == Theme.defaultAccent)
    appearance.accent = .fixed(.sky)
    #expect(theme.accent == RGB(hex: 0x38bdf8))
  }

  @Test func remembersTheChoices() {
    let defaults = UserDefaults(suiteName: UUID().uuidString)!
    let first = AppearanceSettings(defaults: defaults)
    first.accent = .fixed(.violet)
    first.motion = .reduce
    first.formatBadges = false
    let again = AppearanceSettings(defaults: defaults)
    #expect(again.accent == .fixed(.violet))
    #expect(again.motion == .reduce)
    #expect(!again.formatBadges)
    #expect(!again.statsForNerds)
  }

  @Test func motionFollowsTheDeviceOnlyOnSystem() {
    let appearance = settings()
    #expect(appearance.reduceMotion(system: true))
    appearance.motion = .full
    #expect(!appearance.reduceMotion(system: true))
    appearance.motion = .reduce
    #expect(appearance.reduceMotion(system: false))
  }
}
