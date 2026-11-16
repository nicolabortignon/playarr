import Foundation
import PlayarrAPI
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

  @Test func streamsAutomaticallyUnlessAQualityIsPickedAndKeepsWhatIsPicked() {
    let defaults = UserDefaults(suiteName: UUID().uuidString)!
    let settings = PlaybackSettings(defaults: defaults)
    let flac = encodable(song(1))
    #expect(settings.streaming == .automatic)
    #expect(settings.downloadQuality == .original)
    // Automatic: by the speed measured, whatever the network; Normal before anything is measured.
    #expect(settings.streamQuality(for: flac, on: .wifi, kbps: nil) == .normal)
    #expect(settings.streamQuality(for: flac, on: .cellular, kbps: 5000) == .original)
    #expect(settings.streamQuality(for: flac, on: .wifi, kbps: 400) == .high)
    // Low Data Mode: never better than Normal.
    #expect(settings.streamQuality(for: flac, on: .constrained, kbps: 5000) == .normal)
    settings.streaming = .high
    settings.downloadQuality = .normal
    let again = PlaybackSettings(defaults: defaults)
    #expect(again.streamQuality(for: flac, on: .wifi, kbps: 50_000) == .high)
    #expect(again.streamQuality(for: flac, on: .cellular, kbps: 100) == .high)
    #expect(again.downloadQuality == .normal)
  }

  @Test func remembersTheSpeedMeasuredOnEachKindOfNetworkForAnHour() {
    let settings = PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!)
    let now = Date()
    settings.remember(measured: 30_000, on: .wifi, now: now)
    settings.remember(measured: 900, on: .cellular, now: now)
    settings.remember(measured: 1, on: .offline, now: now)
    #expect(settings.lastMeasured(on: .wifi, now: now.addingTimeInterval(600)) == 30_000)
    #expect(settings.lastMeasured(on: .cellular, now: now) == 900)
    #expect(settings.lastMeasured(on: .constrained, now: now) == nil)
    #expect(settings.lastMeasured(on: .offline, now: now) == nil)
    #expect(settings.lastMeasured(on: .wifi, now: now.addingTimeInterval(3601)) == nil)
  }

  @Test func onlyCrossfadeFades() {
    let settings = PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!)
    settings.crossfade = 6
    settings.transitions = .dj
    #expect(settings.crossfadeSeconds == 0)
  }
}
