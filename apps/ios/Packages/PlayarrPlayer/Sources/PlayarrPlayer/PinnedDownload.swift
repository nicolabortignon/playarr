import Foundation
import PlayarrAPI

/// An album, playlist, mix or Favorites downloaded to this device, as `Download` in apps/web/src/player/offline.ts
/// (renamed: `Download` is phase 3's one-file fetch). Its songs stay until it's removed, and don't count towards the
/// limit for songs kept as you listen.
public struct PinnedDownload: Codable, Sendable, Equatable, Identifiable {
  /// "album:12", "playlist:3", "mix:discovery", "favorites": see `Key`.
  public var key: String
  public var title: String
  public var subtitle: String?
  /// The server path of its cover.
  public var coverUrl: String?
  /// Where it lives in the app: "/albums/12".
  public var href: String
  /// Its songs as of the last visit: what's downloaded, and what plays offline.
  public var tracks: [Track]
  public var addedAt: Date
  /// The DJ transitions between its songs, by `OfflineRules.pair`, kept so the download mixes offline too.
  public var transitions: [String: KeptTransition]
  /// Even volume for its songs, by recording id, so they play levelled without a connection.
  public var levels: [String: TrackLevel]

  public var id: String { key }

  public init(
    key: String, title: String, subtitle: String? = nil, coverUrl: String? = nil, href: String, tracks: [Track],
    addedAt: Date = Date(), transitions: [String: KeptTransition] = [:], levels: [String: TrackLevel] = [:]
  ) {
    self.key = key
    self.title = title
    self.subtitle = subtitle
    self.coverUrl = coverUrl
    self.href = href
    self.tracks = tracks
    self.addedAt = addedAt
    self.transitions = transitions
    self.levels = levels
  }

  /// The keys the web uses, so a download means the same thing on both.
  public enum Key {
    public static func album(_ id: Int) -> String { "album:\(id)" }
    public static func playlist(_ id: Int) -> String { "playlist:\(id)" }
    public static func mix(_ key: String) -> String { "mix:\(key)" }
    public static let favorites = "favorites"
  }
}
