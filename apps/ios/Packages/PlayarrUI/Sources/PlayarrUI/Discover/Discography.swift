import PlayarrAPI

/// An artist's MusicBrainz discography laid out as the web lays it out (pages/DiscoverArtist.tsx, and the
/// "Not in your library" sections of pages/Artist.tsx).
public struct Discography: Equatable, Sendable {
  public struct Group: Equatable, Sendable, Identifiable {
    public let title: String
    public let albums: [DiscoverAlbum]
    public var id: String { title }
    /// "4 releases".
    public var kicker: String { Format.plural(albums.count, "release") }
  }

  public let groups: [Group]
  /// Releases already playable.
  public let owned: Int
  /// The album a song led here for (`?album=`), when it's among these.
  public let highlighted: String?
  /// Said when that album isn't among them.
  public let notice: String?
  /// "12 releases · 3 in your library".
  public let summary: String
  /// Said when MusicBrainz lists nothing (and didn't fail).
  public let empty: String?

  /// The Discover artist page: Albums, then EPs & soundtracks.
  public init(_ artist: DiscoverArtistDetail, wanted album: String? = nil) {
    groups = Self.split(artist.albums, albums: "Albums", others: "EPs & soundtracks")
    owned = artist.albums.filter { $0.availability.state == .available }.count
    let match = album.flatMap { wanted in artist.albums.first { TitleKey.of($0.title) == TitleKey.of(wanted) } }
    highlighted = match?.mbid
    notice = album.flatMap { wanted in
      match == nil && !artist.albums.isEmpty
        ? "“\(wanted)” isn’t among these albums and EPs; it’s probably a single or a compilation. You can still request it from the song."
        : nil
    }
    summary = "\(Format.plural(artist.albums.count, "release")) · \(owned) in your library"
    empty = artist.discographyError == nil && artist.albums.isEmpty ? "MusicBrainz lists no albums or EPs for this artist." : nil
  }

  /// A library artist's page: their albums and EPs not in the library at all (those partly here have their own
  /// Request in the sections above).
  public static func notInLibrary(_ artist: DiscoverArtistDetail, owned: [Album]) -> [Group] {
    let ownedIds = Set(owned.compactMap(\.mbid))
    let missing = artist.albums.filter { album in
      !ownedIds.contains(album.mbid) && album.availability.state != .available && album.availability.state != .partial
    }
    return split(missing, albums: "Albums not in your library", others: "EPs & soundtracks not in your library")
  }

  private static func split(_ albums: [DiscoverAlbum], albums albumsTitle: String, others: String) -> [Group] {
    [
      Group(title: albumsTitle, albums: albums.filter { $0.type == "Album" }),
      Group(title: others, albums: albums.filter { $0.type != "Album" }),
    ].filter { !$0.albums.isEmpty }
  }
}
