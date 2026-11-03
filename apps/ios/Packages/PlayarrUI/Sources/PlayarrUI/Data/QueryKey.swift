import Foundation
import PlayarrAPI

/// What a cached answer is, named like the web's React Query keys (apps/web/src/lib/queries.ts).
public struct QueryKey: Hashable, Sendable, CustomStringConvertible {
  public let name: String
  public let parts: [String]

  public init(_ name: String, _ parts: String...) {
    self.name = name
    self.parts = parts
  }

  /// The library data kept on disk between launches, as the web's `KEPT` (apps/web/src/lib/queryClient.ts).
  public static let keptNames: Set<String> = ["artists", "artist", "albums", "album", "favorites", "playlists", "playlist", "mixes"]

  /// Kept on disk: library data, but not a shuffle (a fresh one each visit).
  public var isKept: Bool { Self.keptNames.contains(name) && parts.first != "random" }

  public var description: String { ([name] + parts).joined(separator: "/") }

  /// A file name for the key: letters, digits and dashes as they are, anything else as hex.
  var fileName: String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
    let raw = ([name] + parts).joined(separator: "--")
    let safe = raw.unicodeScalars.allSatisfy { allowed.contains($0) && $0.isASCII }
    return (safe ? raw : raw.utf8.map { String(format: "%02x", $0) }.joined()) + ".json"
  }

  public static let artists = QueryKey("artists")
  public static func artist(_ id: Int) -> QueryKey { QueryKey("artist", String(id)) }
  public static func artistTracks(_ id: Int) -> QueryKey { QueryKey("artist-tracks", String(id)) }
  public static func albums(_ sort: AlbumSort, limit: Int? = nil) -> QueryKey {
    limit.map { QueryKey("albums", sort.rawValue, String($0)) } ?? QueryKey("albums", sort.rawValue)
  }
  public static func randomAlbums(seed: Int) -> QueryKey { QueryKey("albums", "random", String(seed)) }
  public static func album(_ id: Int) -> QueryKey { QueryKey("album", String(id)) }
  public static let favorites = QueryKey("favorites")
  public static let playlists = QueryKey("playlists")
  public static func playlist(_ id: Int) -> QueryKey { QueryKey("playlist", String(id)) }
  public static let mixes = QueryKey("mixes")
  public static let health = QueryKey("health")
  public static let recentAlbums = QueryKey("recent-albums")
  public static func search(_ query: String) -> QueryKey { QueryKey("search", query) }
  public static func lyrics(_ trackId: Int) -> QueryKey { QueryKey("lyrics", String(trackId)) }
  public static func stats(_ range: String) -> QueryKey { QueryKey("stats", range) }
  public static func similarArtists(_ mbid: String) -> QueryKey { QueryKey("similar-artists", mbid) }
}
