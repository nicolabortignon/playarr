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

  @Test func streamsAtTheWebsQualitiesForEachNetworkAndKeepsWhatIsPicked() {
    let defaults = UserDefaults(suiteName: UUID().uuidString)!
    let settings = PlaybackSettings(defaults: defaults)
    #expect(settings.wifiQuality == .original)
    #expect(settings.cellularQuality == .normal)
    #expect(settings.downloadQuality == .original)
    #expect(settings.streamQuality(on: .wifi) == .original)
    #expect(settings.streamQuality(on: .cellular) == .normal)
    #expect(settings.streamQuality(on: .constrained) == .normal)
    settings.wifiQuality = .high
    settings.cellularQuality = .original
    settings.downloadQuality = .normal
    let again = PlaybackSettings(defaults: defaults)
    #expect(again.streamQuality(on: .wifi) == .high)
    #expect(again.streamQuality(on: .cellular) == .original)
    #expect(again.downloadQuality == .normal)
  }

  @Test func onlyCrossfadeFades() {
    let settings = PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!)
    settings.crossfade = 6
    settings.transitions = .dj
    #expect(settings.crossfadeSeconds == 0)
  }
}
