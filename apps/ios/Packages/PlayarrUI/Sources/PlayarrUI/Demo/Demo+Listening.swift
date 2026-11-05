import PlayarrAPI

extension Demo {
  /// "Late night" with its songs (Angel and Risingson), as GET /api/playlists/1 answers it.
  static let lateNight = PlaylistDetail(
    id: playlist.id, name: playlist.name, description: playlist.description, trackCount: 2, duration: 677, cover: playlist.cover,
    updatedAt: playlist.updatedAt, owner: playlist.owner, shared: playlist.shared, mine: playlist.mine,
    items: mezzanineTracks.prefix(2).enumerated().map { index, track in
      PlaylistItem(
        itemId: index + 1, recordingId: track.recordingId, title: track.title, artistName: track.artistName,
        albumTitle: track.albumTitle, addedAt: when, track: track)
    })

  /// "Your vibes" with its songs.
  static let mixDetail = MixDetail(
    key: mix.key, kind: mix.kind, title: mix.title, subtitle: mix.subtitle, description: mix.description, trackCount: 3,
    duration: 1033, covers: mix.covers, hue: mix.hue, generatedAt: mix.generatedAt, refreshesAt: mix.refreshesAt,
    tracks: mezzanineTracks)

  /// A month of listening (or a calendar year): Massive Attack most of all.
  static func stats(range: String) -> ListeningStats {
    var hours = Array(repeating: 0.0, count: 24)
    hours[21] = 125
    hours[8] = 30
    return ListeningStats(
      range: range, to: when, minutes: 155, plays: 31, songs: 8, artists: 2, days: 6, newArtists: 1, longestStreak: 3,
      topArtists: [.init(artist: artist, plays: 20, minutes: 110), .init(artist: otherArtist, plays: 11, minutes: 45)],
      topAlbums: [.init(album: albums[0], plays: 14, minutes: 80)],
      topTracks: mezzanineTracks.map { .init(track: $0, plays: 5) }, topGenres: [.init(genre: "trip hop", minutes: 155)],
      hours: hours, weekdays: [10, 20, 30, 25, 20, 30, 20], months: range.count == 4 ? Array(repeating: 12, count: 12) : nil,
      firstSong: .init(track: mezzanineTracks[0], at: when), years: [2026])
  }
}

extension Demo {
  /// `-UITestsManyPlaylists`: two dozen more playlists like Late night, enough that the iPad's sidebar scrolls.
  static let morePlaylists: [PlaylistDetail] = [
    "Sunday morning", "Rainy commute", "Deep focus", "Kitchen dancing", "Long drive", "Bristol sound", "After hours",
    "Slow burn", "Headphones only", "Night bus", "First coffee", "Vinyl Fridays", "Low light", "Stormy", "Backyard",
    "Road trip", "Study hall", "Dub plates", "Late summer", "Quiet storm", "Basement", "Neon", "Cool down", "Encore",
  ].enumerated().map { index, name in
    var playlist = lateNight
    playlist.id = 1000 + index
    playlist.name = name
    return playlist
  }
}
