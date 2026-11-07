import PlayarrAPI

extension Demo {
  /// What's out there beyond the demo library, as a server without Lidarr answers search from MusicBrainz (with Deezer
  /// for songs): a few of its artists' other albums and songs, one artist not in it, and Mezzanine, which is.
  static let beyond = DiscoverResults(
    artists: [
      DiscoverArtist(mbid: "art-1", name: "Massive Attack", genres: ["trip hop"], artistId: 7),
      DiscoverArtist(mbid: "art-3", name: "Mass Gothic", disambiguation: "US indie rock band", genres: ["indie rock"]),
      DiscoverArtist(mbid: "art-4", name: "Tricky", disambiguation: "English musician", genres: ["trip hop"]),
    ],
    albums: [
      DiscoverAlbum(
        mbid: "rg-70", title: "Mezzanine", artistName: "Massive Attack", artistMbid: "art-1", year: 1998, type: "Album", secondaryTypes: [],
        availability: Availability(state: .partial, albumId: 70, have: 3, total: 5)),
      DiscoverAlbum(
        mbid: "rg-heligoland", title: "Heligoland", artistName: "Massive Attack", artistMbid: "art-1", year: 2010, type: "Album",
        secondaryTypes: [], availability: Availability(state: .noneValue)),
      DiscoverAlbum(
        mbid: "rg-blue-lines", title: "Blue Lines", artistName: "Massive Attack", artistMbid: "art-1", year: 1991, type: "Album",
        secondaryTypes: [], availability: Availability(state: .noneValue)),
      DiscoverAlbum(
        mbid: "rg-third", title: "Third", artistName: "Portishead", artistMbid: "art-2", year: 2008, type: "Album", secondaryTypes: [],
        availability: Availability(state: .noneValue)),
      DiscoverAlbum(
        mbid: "rg-maxinquaye", title: "Maxinquaye", artistName: "Tricky", artistMbid: "art-4", year: 1995, type: "Album", secondaryTypes: [],
        availability: Availability(state: .noneValue)),
    ],
    tracks: [
      DiscoverTrack(
        id: "dz-teardrop", title: "Teardrop", artistName: "Massive Attack", albumTitle: "Mezzanine", duration: 330,
        album: AlbumRef(mbid: "rg-70", artistName: "Massive Attack", albumTitle: "Mezzanine"),
        availability: Availability(state: .partial, albumId: 70, have: 3, total: 5), artistId: 7, artistMbid: "art-1"),
      DiscoverTrack(
        id: "dz-paradise-circus", title: "Paradise Circus", artistName: "Massive Attack", albumTitle: "Heligoland", duration: 297,
        album: AlbumRef(mbid: "rg-heligoland", artistName: "Massive Attack", albumTitle: "Heligoland"),
        availability: Availability(state: .noneValue), artistId: 7, artistMbid: "art-1"),
      DiscoverTrack(
        id: "dz-machine-gun", title: "Machine Gun", artistName: "Portishead", albumTitle: "Third", duration: 283,
        album: AlbumRef(mbid: "rg-third", artistName: "Portishead", albumTitle: "Third"),
        availability: Availability(state: .noneValue), artistId: 8, artistMbid: "art-2"),
    ])

  /// The demo artists' discographies, as a server without Lidarr reads them from MusicBrainz: what their pages list
  /// under "Not in your library" (the albums the library has in part or whole are left out there).
  static let discographies: [DiscoverArtistDetail] = [
    DiscoverArtistDetail(
      mbid: "art-1", name: "Massive Attack", genres: ["trip hop"], artistId: 7,
      albums: [
        discography("rg-blue-lines", "Blue Lines", 1991, artist: "Massive Attack", artistMbid: "art-1"),
        discography("rg-71", "Protection", 1994, artist: "Massive Attack", artistMbid: "art-1", availability: Availability(state: .available, albumId: 71)),
        discography(
          "rg-70", "Mezzanine", 1998, artist: "Massive Attack", artistMbid: "art-1",
          availability: Availability(state: .partial, albumId: 70, have: 3, total: 5)),
        discography("rg-100th-window", "100th Window", 2003, artist: "Massive Attack", artistMbid: "art-1"),
        discography("rg-heligoland", "Heligoland", 2010, artist: "Massive Attack", artistMbid: "art-1"),
        discography("rg-ritual-spirit", "Ritual Spirit", 2016, type: "EP", artist: "Massive Attack", artistMbid: "art-1"),
      ]),
    DiscoverArtistDetail(
      mbid: "art-2", name: "Portishead", genres: ["trip hop"], artistId: 8,
      albums: [
        discography("rg-80", "Dummy", 1994, artist: "Portishead", artistMbid: "art-2", availability: Availability(state: .available, albumId: 80)),
        discography("rg-portishead", "Portishead", 1997, artist: "Portishead", artistMbid: "art-2"),
        discography("rg-third", "Third", 2008, artist: "Portishead", artistMbid: "art-2"),
      ]),
  ]

  private static func discography(
    _ mbid: String, _ title: String, _ year: Int, type: String = "Album", artist: String, artistMbid: String,
    availability: Availability = Availability(state: .noneValue)
  ) -> DiscoverAlbum {
    DiscoverAlbum(
      mbid: mbid, title: title, artistName: artist, artistMbid: artistMbid, year: year, type: type, secondaryTypes: [], availability: availability)
  }

  /// The demo's search beyond the library: what's out there whose name, title or artist holds what's typed.
  public static func discover(_ query: String) -> DiscoverResults {
    let q = query.lowercased()
    let match = { (texts: [String]) in !q.isEmpty && texts.contains { $0.lowercased().contains(q) } }
    return DiscoverResults(
      artists: beyond.artists.filter { match([$0.name]) },
      albums: beyond.albums.filter { match([$0.title, $0.artistName]) },
      tracks: beyond.tracks.filter { match([$0.title, $0.artistName]) })
  }
}
