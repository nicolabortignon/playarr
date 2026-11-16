import Foundation
import PlayarrAPI
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
  /// Streaming quality: Automatic (by how fast songs arrive, `AutoQuality`), or one quality whatever the connection.
  public var streaming: StreamingChoice { didSet { defaults.set(streaming.rawValue, forKey: Key.streaming) } }
  /// Downloads' quality (Original), as `downloadQuality` on the web (plan 2 §1).
  public var downloadQuality: StreamQuality { didSet { defaults.set(downloadQuality.rawValue, forKey: Key.downloadQuality) } }

  @ObservationIgnored private let defaults: UserDefaults

  private enum Key {
    static let transitions = "playback.transitions"
    static let crossfade = "playback.crossfade"
    static let levelVolume = "playback.levelVolume"
    static let autoplay = "playback.autoplay"
    static let recordPlays = "playback.recordPlays"
    static let offlineLimit = "playback.offlineLimit"
    static let cellularDownloads = "playback.cellularDownloads"
    static let streaming = "playback.streaming"
    static let downloadQuality = "playback.downloadQuality"
    static func measured(_ network: NetworkKind) -> String { "playback.measured.\(network)" }
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
    streaming = defaults.string(forKey: Key.streaming).flatMap(StreamingChoice.init) ?? .automatic
    downloadQuality = defaults.string(forKey: Key.downloadQuality).flatMap(StreamQuality.init) ?? .original
  }

  /// The quality a song streams at: the one chosen, or Automatic's for the connection's speed as measured (`kbps`),
  /// never better than Normal in Low Data Mode.
  public func streamQuality(for track: Track, on network: NetworkKind, kbps: Double?) -> StreamQuality {
    streaming.fixed ?? AutoQuality.pick(for: track, kbps: kbps, lowDataMode: network == .constrained)
  }

  /// The speed last measured on this kind of network (kbps), within the last hour: where Automatic starts after a
  /// launch or a change of network, rather than at Normal.
  public func lastMeasured(on network: NetworkKind, now: Date = Date()) -> Double? {
    guard network != .offline, let saved = defaults.array(forKey: Key.measured(network)) as? [Double], saved.count == 2,
      now.timeIntervalSince1970 - saved[1] < Self.measuredLasts
    else { return nil }
    return saved[0]
  }

  public func remember(measured kbps: Double, on network: NetworkKind, now: Date = Date()) {
    guard network != .offline else { return }
    defaults.set([kbps, now.timeIntervalSince1970], forKey: Key.measured(network))
  }

  /// How long a speed measured is worth starting from.
  static let measuredLasts: TimeInterval = 60 * 60

  /// Seconds songs overlap on this setting: only Crossfade fades (DJ mix plays gapless until it can mix).
  public var crossfadeSeconds: Double { transitions == .crossfade ? crossfade : 0 }
}
