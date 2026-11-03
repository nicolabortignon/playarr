import Foundation
import Observation

/// Settings → Playback, per device as on the web (apps/web/src/lib/prefs.ts), kept in UserDefaults.
@MainActor @Observable
public final class PlaybackSettings {
  public enum Transitions: String, Sendable, CaseIterable { case off, crossfade, dj }
  /// The crossfade lengths offered (seconds), as `CROSSFADES` on the web.
  public static let crossfades: [Double] = [0, 3, 6, 9, 12]

  public var transitions: Transitions { didSet { defaults.set(transitions.rawValue, forKey: Key.transitions) } }
  public var crossfade: Double { didSet { defaults.set(crossfade, forKey: Key.crossfade) } }
  /// "Even out the volume".
  public var levelVolume: Bool { didSet { defaults.set(levelVolume, forKey: Key.levelVolume) } }
  /// "Keep playing when the queue ends".
  public var autoplay: Bool { didSet { defaults.set(autoplay, forKey: Key.autoplay) } }
  /// "Count what this device plays".
  public var recordPlays: Bool { didSet { defaults.set(recordPlays, forKey: Key.recordPlays) } }
  /// "On this device: keep up to": room for songs kept as you listen, in bytes (0 = Off). See `OfflineLimit`.
  public var offlineLimit: Int64 { didSet { defaults.set(offlineLimit, forKey: Key.offlineLimit) } }
  /// "Allow downloads on mobile data" (and personal hotspots). Off: downloads wait for Wi-Fi.
  public var cellularDownloads: Bool { didSet { defaults.set(cellularDownloads, forKey: Key.cellularDownloads) } }

  @ObservationIgnored private let defaults: UserDefaults

  private enum Key {
    static let transitions = "playback.transitions"
    static let crossfade = "playback.crossfade"
    static let levelVolume = "playback.levelVolume"
    static let autoplay = "playback.autoplay"
    static let recordPlays = "playback.recordPlays"
    static let offlineLimit = "playback.offlineLimit"
    static let cellularDownloads = "playback.cellularDownloads"
  }

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    let saved = defaults.double(forKey: Key.crossfade)
    crossfade = Self.crossfades.contains(saved) ? saved : 0
    transitions = defaults.string(forKey: Key.transitions).flatMap(Transitions.init) ?? .off
    levelVolume = defaults.object(forKey: Key.levelVolume) as? Bool ?? true
    autoplay = defaults.object(forKey: Key.autoplay) as? Bool ?? true
    recordPlays = defaults.object(forKey: Key.recordPlays) as? Bool ?? true
    let limit = (defaults.object(forKey: Key.offlineLimit) as? NSNumber)?.int64Value
    offlineLimit = limit.flatMap { OfflineLimit.options.contains($0) ? $0 : nil } ?? OfflineLimit.defaultLimit
    cellularDownloads = defaults.object(forKey: Key.cellularDownloads) as? Bool ?? false
  }

  /// Seconds songs overlap on this setting: only Crossfade fades (DJ mix plays gapless until it can mix).
  public var crossfadeSeconds: Double { transitions == .crossfade ? crossfade : 0 }
}
