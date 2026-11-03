import Foundation
import PlayarrAPI

/// A small library in memory: what the UI tests browse (`-UITestsDemo`) and what view-model tests use as fakes.
/// Two artists, three albums (one with missing songs, one on two discs), lyrics, a mix, a playlist and a favorite.
public enum Demo {
  public static let baseURL = URL(string: "https://demo.playarr.invalid")!
  public static let server = ServerInfo(id: "demo-server", name: "Demo", version: "0.0.0", minAppVersion: "1.0.0", setup: false)
  public static let account = Account(id: 1, username: "demo", name: "Demo", role: .admin, canRequest: false, sources: nil, hasPassword: true)
  static let when = "2026-11-01T12:00:00.000Z"
  static let flac = AudioFormat(codec: "FLAC", container: "flac", bits: 16, sampleRate: 44_100, lossless: true)
  static let hiRes = AudioFormat(codec: "FLAC", container: "flac", bits: 24, sampleRate: 96_000, lossless: true)

  public static let artist = Artist(
    id: 7, name: "Massive Attack", sortName: "Massive Attack", genres: ["trip hop"],
    overview: "Bristol collective at the heart of trip hop.", albumCount: 2, trackCount: 5,
    imageUrl: "/art/artist/7/poster", mbid: "art-1")
  public static let otherArtist = Artist(
    id: 8, name: "Portishead", sortName: "Portishead", genres: ["trip hop"], albumCount: 1, trackCount: 3,
    imageUrl: "/art/artist/8/poster", mbid: "art-2")
  public static let artists = [artist, otherArtist]

  static func track(_ id: Int, _ title: String, album: Int, albumTitle: String, artist: Artist, number: Int, disc: Int = 1, duration: Double, format: AudioFormat = flac) -> Track {
    Track(
      id: id, recordingId: "rec-\(id)", fileId: 9000 + id, albumId: album, artistId: artist.id, title: title,
      artistName: artist.name, albumTitle: albumTitle, trackNumber: number, discNumber: disc, duration: duration,
      explicit: false, format: format, size: 30_000_000, streamUrl: "/stream/\(9000 + id)", coverUrl: "/art/album/\(album)/cover")
  }

  public static let mezzanineTracks = [
    track(700, "Angel", album: 70, albumTitle: "Mezzanine", artist: artist, number: 1, duration: 379),
    track(701, "Risingson", album: 70, albumTitle: "Mezzanine", artist: artist, number: 2, duration: 298),
    track(703, "Inertia Creeps", album: 70, albumTitle: "Mezzanine", artist: artist, number: 4, duration: 356),
  ]
  public static let protectionTracks = [
    track(710, "Protection", album: 71, albumTitle: "Protection", artist: artist, number: 1, duration: 471),
    track(711, "Karmacoma", album: 71, albumTitle: "Protection", artist: artist, number: 2, duration: 316),
  ]
  public static let dummyTracks = [
    track(800, "Mysterons", album: 80, albumTitle: "Dummy", artist: otherArtist, number: 1, duration: 306, format: hiRes),
    track(801, "Sour Times", album: 80, albumTitle: "Dummy", artist: otherArtist, number: 2, duration: 254, format: hiRes),
    track(810, "Glory Box", album: 80, albumTitle: "Dummy", artist: otherArtist, number: 1, disc: 2, duration: 306, format: hiRes),
  ]
  public static let tracks = mezzanineTracks + protectionTracks + dummyTracks

  public static let mezzanine = AlbumDetail(
    id: 70, title: "Mezzanine", artistId: 7, artistName: "Massive Attack", year: 1998, albumType: "Album",
    secondaryTypes: [], genres: ["trip hop"], duration: 1033, trackCount: 3, totalTrackCount: 5,
    coverUrl: "/art/album/70/cover", addedAt: when, format: flac, mbid: "rg-70",
    overview: "Darker and heavier than what came before.", tracks: mezzanineTracks, discCount: 1,
    missingTracks: [
      MissingTrack(recordingId: "rec-702", title: "Teardrop", trackNumber: 3, discNumber: 1, duration: 330),
      MissingTrack(recordingId: "rec-704", title: "Exchange", trackNumber: 5, discNumber: 1, duration: 251),
    ])
  public static let protection = AlbumDetail(
    id: 71, title: "Protection", artistId: 7, artistName: "Massive Attack", year: 1994, albumType: "Album",
    secondaryTypes: [], genres: ["trip hop"], duration: 787, trackCount: 2, totalTrackCount: 2,
    coverUrl: "/art/album/71/cover", addedAt: when, format: flac, tracks: protectionTracks, discCount: 1, missingTracks: [])
  public static let dummy = AlbumDetail(
    id: 80, title: "Dummy", artistId: 8, artistName: "Portishead", year: 1994, albumType: "Album",
    secondaryTypes: [], genres: ["trip hop"], duration: 866, trackCount: 3, totalTrackCount: 3,
    coverUrl: "/art/album/80/cover", addedAt: when, format: hiRes, tracks: dummyTracks, discCount: 2, missingTracks: [])
  public static let albumDetails = [mezzanine, protection, dummy]
  public static let albums = albumDetails.map(album)

  /// An album as lists show it.
  public static func album(_ detail: AlbumDetail) -> Album {
    Album(
      id: detail.id, title: detail.title, artistId: detail.artistId, artistName: detail.artistName, year: detail.year,
      albumType: detail.albumType, secondaryTypes: detail.secondaryTypes, genres: detail.genres, duration: detail.duration,
      trackCount: detail.trackCount, totalTrackCount: detail.totalTrackCount, coverUrl: detail.coverUrl,
      addedAt: detail.addedAt, format: detail.format, mbid: detail.mbid)
  }

  public static func artistDetail(_ artist: Artist) -> ArtistDetail {
    ArtistDetail(
      id: artist.id, name: artist.name, sortName: artist.sortName, genres: artist.genres, overview: artist.overview,
      albumCount: artist.albumCount, trackCount: artist.trackCount, imageUrl: artist.imageUrl, mbid: artist.mbid,
      albums: albums.filter { $0.artistId == artist.id })
  }

  public static let lyrics = Lyrics(
    synced: [
      Lyrics.SyncedItem(at: 0, text: "You are my angel"),
      Lyrics.SyncedItem(at: 12, text: "Come from way above"),
      Lyrics.SyncedItem(at: 24, text: "To bring me love"),
    ],
    source: .lrclib)

  public static let mix = MixSummary(
    key: "vibes", kind: .vibes, title: "Your vibes", subtitle: "Massive Attack and more",
    description: "Songs you play the most at this hour", trackCount: 3, duration: 1033,
    covers: ["/art/album/70/cover"], hue: 210, generatedAt: when, refreshesAt: when)

  public static let playlist = PlaylistSummary(
    id: 1, name: "Late night", description: "For the drive home", trackCount: 2, duration: 677,
    cover: PlaylistCoverInfo(url: "/art/playlist/1?v=demo", layout: .currents, variant: 0, frozen: true, stale: false, energy: 0.4, styles: [], analyzed: 2, total: 2, pending: false),
    updatedAt: when, owner: "Demo", shared: false, mine: true)

  public static let favorite = FavoriteTrack(
    id: 701, recordingId: "rec-701", fileId: 9701, albumId: 70, artistId: 7, title: "Risingson",
    artistName: "Massive Attack", albumTitle: "Mezzanine", trackNumber: 2, discNumber: 1, duration: 298,
    explicit: false, format: flac, size: 30_000_000, streamUrl: "/stream/9701", coverUrl: "/art/album/70/cover",
    favoritedAt: when)

  public static let health = HealthStatus(
    ok: true, media: HealthStatus.Media(source: .local, ok: true),
    library: LibraryStats(artists: 2, albums: 3, tracks: 8, durationSeconds: 2686, sizeBytes: 240_000_000, refreshedAt: when),
    requests: false)

  /// What the demo server answers, by method and path (search, which depends on what's typed, is `DemoAPI`'s).
  public static var routes: [(method: HTTPMethod, path: String, answer: any Encodable & Sendable)] {
    var routes: [(method: HTTPMethod, path: String, answer: any Encodable & Sendable)] = [
      (.get, "/api/health", health),
      (.get, "/api/artists", artists),
      (.get, "/api/albums", albums),
      (.get, "/api/albums/random", albums),
      (.get, "/api/tracks/random", tracks),
      (.get, "/api/plays/recent-albums", albums),
      (.get, "/api/favorites", [favorite]),
      (.get, "/api/playlists", [playlist]),
      (.get, "/api/mixes", [mix]),
      (.get, "/api/discover/artists/art-1/similar", [DiscoverArtist(mbid: "art-2", name: "Portishead", genres: ["trip hop"], artistId: 8)]),
      (.post, "/api/radio", dummyTracks),
    ]
    for artist in artists {
      routes.append((.get, "/api/artists/\(artist.id)", artistDetail(artist)))
      routes.append((.get, "/api/artists/\(artist.id)/tracks", tracks.filter { $0.artistId == artist.id }))
    }
    for album in albumDetails { routes.append((.get, "/api/albums/\(album.id)", album)) }
    for track in tracks { routes.append((.get, "/api/tracks/\(track.id)/lyrics", ["lyrics": track.id == 700 ? lyrics : nil])) }
    return routes
  }

  /// The library's search, as the server does it (enough of it): names and titles containing what's typed.
  public static func search(_ query: String) -> SearchResults {
    let q = query.lowercased()
    let match = { (text: String) in !q.isEmpty && text.lowercased().contains(q) }
    return SearchResults(
      artists: artists.filter { match($0.name) },
      albums: albums.filter { match($0.title) || match($0.artistName) },
      tracks: tracks.filter { match($0.title) || match($0.artistName) })
  }
}
