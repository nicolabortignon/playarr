import Foundation
import Testing
@testable import PlayarrPlayer

@MainActor
struct OfflineLimitTests {
  @Test func offersTheWebsLimitsInItsWords() {
    #expect(OfflineLimit.options.map(OfflineLimit.label) == ["Off", "512 MB", "1 GB", "2 GB", "5 GB", "10 GB"])
    #expect(ByteCount.format(1_610_612_736) == "1.5 GB")
    #expect(ByteCount.format(12 * OfflineLimit.gigabyte + 300 * OfflineLimit.megabyte) == "12 GB")
    #expect(ByteCount.format(40 * OfflineLimit.megabyte) == "40 MB")
    #expect(ByteCount.format(0) == "0 MB")
  }

  @Test func keepsTwoGigabytesAndNoMobileDataUntilPicked() {
    let defaults = UserDefaults(suiteName: UUID().uuidString)!
    let settings = PlaybackSettings(defaults: defaults)
    #expect(settings.offlineLimit == 2 * OfflineLimit.gigabyte)
    #expect(!settings.cellularDownloads)
    settings.offlineLimit = 0
    settings.cellularDownloads = true
    let again = PlaybackSettings(defaults: defaults)
    #expect(again.offlineLimit == 0)
    #expect(again.cellularDownloads)
    defaults.set(Int64(123), forKey: "playback.offlineLimit")
    #expect(PlaybackSettings(defaults: defaults).offlineLimit == OfflineLimit.defaultLimit)
  }
}
