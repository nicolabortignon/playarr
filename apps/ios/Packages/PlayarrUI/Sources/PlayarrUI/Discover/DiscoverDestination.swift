import PlayarrAPI

/// Where a Discover link leads (lib/links.ts): the library's page when the artist or album is there, else the
/// artist's MusicBrainz discography, else a lookup by name first. Pushed on the tab's navigation stack as its `route`.
public enum DiscoverDestination: Hashable, Sendable {
  case libraryArtist(id: Int)
  case libraryAlbum(id: Int)
  /// The discography; `album` highlights one of its albums (`?album=` on the web).
  case discoverArtist(mbid: String, album: String?)
  /// Only a name is known: look it up on MusicBrainz, then show what it leads to.
  case findArtist(name: String, album: String?)
  case requests

  /// The page it opens, as the tab stacks push it.
  public var route: Route {
    switch self {
    case .libraryArtist(let id): .artist(id)
    case .libraryAlbum(let id): .album(id)
    case .discoverArtist(let mbid, let album): .discoverArtist(mbid: mbid, album: album)
    case .findArtist(let name, let album): .findArtist(name: name, album: album)
    case .requests: .requests
    }
  }

  /// artistHref.
  public static func artist(id: Int?, mbid: String?, name: String) -> DiscoverDestination {
    if let id { return .libraryArtist(id: id) }
    if let mbid { return .discoverArtist(mbid: mbid, album: nil) }
    return .findArtist(name: name, album: nil)
  }

  /// albumHref: an owned album opens its page; another opens the artist's discography with it highlighted.
  public static func album(id: Int?, artistMbid: String?, artistName: String, title: String) -> DiscoverDestination {
    if let id { return .libraryAlbum(id: id) }
    if let artistMbid { return .discoverArtist(mbid: artistMbid, album: title) }
    return .findArtist(name: artistName, album: title)
  }

  /// A Discover album card: the album's page when any of it is here, else its artist's discography.
  public static func card(_ album: DiscoverAlbum) -> DiscoverDestination {
    let a = album.availability
    let partial = a.state == .partial || (a.have != nil && a.albumId != nil)
    if (a.state == .available || partial), let id = a.albumId { return .libraryAlbum(id: id) }
    return .discoverArtist(mbid: album.artistMbid, album: nil)
  }

  /// A Discover song row opens its album when the album is (partly) here.
  public static func row(_ track: DiscoverTrack) -> DiscoverDestination? {
    let a = track.availability
    guard let id = a.albumId, a.state == .available || a.have != nil else { return nil }
    return .libraryAlbum(id: id)
  }

  /// A Discover artist card.
  public static func card(_ artist: DiscoverArtist) -> DiscoverDestination {
    .artist(id: artist.artistId, mbid: artist.mbid, name: artist.name)
  }

  /// Where a looked-up name leads (FindArtist).
  public static func found(_ match: ArtistMatch, name: String, album: String?) -> DiscoverDestination {
    if let album { return .album(id: nil, artistMbid: match.mbid, artistName: name, title: album) }
    return .artist(id: match.artistId, mbid: match.mbid, name: name)
  }
}
