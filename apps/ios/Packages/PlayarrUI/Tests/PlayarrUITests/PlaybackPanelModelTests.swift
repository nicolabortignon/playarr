import Foundation
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct PlaybackPanelModelTests {
  @Test func aFadeStartsAtSixSeconds() {
    let settings = PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!)
    let panel = PlaybackPanelModel(settings: settings)
    panel.choose(.crossfade)
    #expect(settings.crossfade == 6)
    settings.crossfade = 12
    panel.choose(.dj)
    #expect(settings.crossfade == 12)
    #expect(PlaybackPanelModel.lengths == [3, 6, 9, 12])
  }
}
