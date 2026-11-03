import Foundation
import PlayarrAPI

/// A page the app can show, named after the web's routes (apps/web/src/routes.tsx). Pages are values, so the same
/// destinations work in the iPhone's tab stacks now and in an iPad split view later.
public enum Route: Hashable, Sendable {
  case album(Int)
  case artist(Int)
  case albums(AlbumSort)
  case artists
  case favorites
  case playlists
  case playlist(Int)
  case mixes
  case mix(String)
  case listening
  /// Your listening for a period or a calendar year ("halfyear", "2025"): the web's `?range=`.
  case listeningRange(StatsRange)
  case settings
  case settingsPanel(SettingsPanel)
  /// An artist's MusicBrainz discography (phase 8); `album` brings one of its albums into view.
  case discoverArtist(mbid: String, album: String?)
  /// Only a name is known: look it up on MusicBrainz, then show what it leads to (phase 8).
  case findArtist(name: String, album: String?)
  /// The albums asked of Lidarr (phase 8).
  case requests

  /// The page at a web path ("/albums/70", "/albums?sort=added"), as "Playing from" links carry; nil if none.
  public init?(href: String) {
    guard let components = URLComponents(string: href) else { return nil }
    let parts = components.path.split(separator: "/").map(String.init)
    let query = { (name: String) in components.queryItems?.first { $0.name == name }?.value }
    switch (parts.first, parts.count) {
    case ("albums", 1): self = .albums(query("sort").map(AlbumSort.init(rawValue:)) ?? .artist)
    case ("albums", 2): guard let id = Int(parts[1]) else { return nil }; self = .album(id)
    case ("artists", 1): self = .artists
    case ("artists", 2): guard let id = Int(parts[1]) else { return nil }; self = .artist(id)
    case ("favorites", 1): self = .favorites
    case ("playlists", 1): self = .playlists
    case ("playlists", 2): guard let id = Int(parts[1]) else { return nil }; self = .playlist(id)
    case ("mixes", 1): self = .mixes
    case ("mixes", 2): self = .mix(parts[1])
    case ("stats", 1): self = query("range").map(Route.listeningRange) ?? .listening
    case ("requests", 1): self = .requests
    case ("settings", 1): self = .settings
    case ("settings", 2):
      if parts[1] == "listening" { self = query("range").map(Route.listeningRange) ?? .listening } else { self = SettingsPanel(rawValue: parts[1]).map(Route.settingsPanel) ?? .settings }
    default: return nil
    }
  }
}
