import Foundation
import Testing
@testable import PlayarrPlayer

@MainActor
struct PlaybackSettingsTests {
  @Test func startsAsTheWebDoesAndKeepsWhatIsPicked() {
    let defaults = UserDefaults(suiteName: UUID().uuidString)!
    let settings = PlaybackSettings(defaults: defaults)
    #expect(settings.transitions == .off)
    #expect(settings.crossfade == 0)
    #expect(settings.levelVolume)
    #expect(settings.autoplay)
    #expect(settings.recordPlays)
    settings.transitions = .crossfade
    settings.crossfade = 9
    settings.levelVolume = false
    let again = PlaybackSettings(defaults: defaults)
    #expect(again.crossfadeSeconds == 9)
    #expect(!again.levelVolume)
  }

  @Test func onlyCrossfadeFades() {
    let settings = PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!)
    settings.crossfade = 6
    settings.transitions = .dj
    #expect(settings.crossfadeSeconds == 0)
  }
}
