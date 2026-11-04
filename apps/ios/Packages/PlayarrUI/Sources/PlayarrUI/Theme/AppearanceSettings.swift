import Foundation
import Observation

/// Settings → Appearance, per device as on the web (apps/web/src/lib/prefs.ts), kept in UserDefaults.
@MainActor @Observable
public final class AppearanceSettings {
  /// The fixed accent colours; the first is Playarr's own orange.
  public enum Fixed: String, Sendable, CaseIterable {
    case orange = "#ff7a1a"
    case rose = "#f43f5e"
    case violet = "#a78bfa"
    case sky = "#38bdf8"
    case green = "#34d399"
    case yellow = "#facc15"

    public var name: String {
      switch self {
      case .orange: "Orange"
      case .rose: "Rose"
      case .violet: "Violet"
      case .sky: "Sky"
      case .green: "Green"
      case .yellow: "Yellow"
      }
    }

    public var rgb: RGB { RGB(hex: UInt32(rawValue.dropFirst(), radix: 16) ?? 0xff7a1a) }
  }

  public enum Accent: Hashable, Sendable {
    case album
    case fixed(Fixed)

    public static let all: [Accent] = [.album] + Fixed.allCases.map(Accent.fixed)

    public var name: String {
      switch self {
      case .album: "From the album art"
      case .fixed(let color): color.name
      }
    }

    var stored: String {
      switch self {
      case .album: "album"
      case .fixed(let color): color.rawValue
      }
    }

    init(stored: String?) {
      self = stored.flatMap(Fixed.init).map(Accent.fixed) ?? .album
    }
  }

  public enum Motion: String, Sendable, CaseIterable {
    case system, reduce, full

    public var label: String {
      switch self {
      case .system: "System"
      case .reduce: "Reduced"
      case .full: "Full"
      }
    }
  }

  public var accent: Accent { didSet { defaults.set(accent.stored, forKey: Key.accent) } }
  public var motion: Motion { didSet { defaults.set(motion.rawValue, forKey: Key.motion) } }
  /// "Show audio format badges".
  public var formatBadges: Bool { didSet { defaults.set(formatBadges, forKey: Key.formatBadges) } }
  /// "Stats for nerds": the overlay itself comes in phase 5.
  public var statsForNerds: Bool { didSet { defaults.set(statsForNerds, forKey: Key.statsForNerds) } }
  /// iPhone: turning the phone on its side with a song queued opens Now Playing.
  public var turnToOpen: Bool { didSet { defaults.set(turnToOpen, forKey: Key.turnToOpen) } }
  /// iPhone: the screen stays on while Now Playing is sideways and the phone is charging (a phone in a stand).
  public var keepScreenOnSideways: Bool { didSet { defaults.set(keepScreenOnSideways, forKey: Key.keepScreenOnSideways) } }

  @ObservationIgnored private let defaults: UserDefaults

  private enum Key {
    static let accent = "appearance.accent"
    static let motion = "appearance.motion"
    static let formatBadges = "appearance.formatBadges"
    static let statsForNerds = "appearance.statsForNerds"
    static let turnToOpen = "appearance.turnToOpen"
    static let keepScreenOnSideways = "appearance.keepScreenOnSideways"
  }

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    accent = Accent(stored: defaults.string(forKey: Key.accent))
    motion = defaults.string(forKey: Key.motion).flatMap(Motion.init) ?? .system
    formatBadges = defaults.object(forKey: Key.formatBadges) as? Bool ?? true
    statsForNerds = defaults.object(forKey: Key.statsForNerds) as? Bool ?? false
    turnToOpen = defaults.object(forKey: Key.turnToOpen) as? Bool ?? true
    keepScreenOnSideways = defaults.object(forKey: Key.keepScreenOnSideways) as? Bool ?? true
  }

  /// Whether to keep animations to a minimum, given the device's own setting.
  public func reduceMotion(system: Bool) -> Bool {
    switch motion {
    case .system: system
    case .reduce: true
    case .full: false
    }
  }
}
