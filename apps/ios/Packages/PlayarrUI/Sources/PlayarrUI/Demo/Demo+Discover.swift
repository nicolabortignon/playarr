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
