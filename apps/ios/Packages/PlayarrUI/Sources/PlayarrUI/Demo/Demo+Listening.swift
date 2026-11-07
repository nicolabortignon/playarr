import PlayarrAPI

extension Demo {
  /// "Late night" with its songs (Angel and Risingson), as GET /api/playlists/1 answers it.
  static let lateNight = PlaylistDetail(
    id: playlist.id, name: playlist.name, description: playlist.description, trackCount: 2, duration: 677, cover: playlist.cover,
    updatedAt: playlist.updatedAt, owner: playlist.owner, shared: playlist.shared, mine: playlist.mine,
    collaborative: playlist.collaborative, canEdit: playlist.canEdit,
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

  /// A month of listening (or a calendar year): Massive Attack most of all, three days running (a new record).
  static func stats(range: String) -> ListeningStats {
    var hours = Array(repeating: 0.0, count: 24)
    hours[21] = 125
    hours[8] = 30
    return ListeningStats(
      range: range, to: when, minutes: 155, plays: 31, songs: 8, artists: 2, days: 6, newArtists: 1, longestStreak: 3, currentStreak: 3,
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

extension Demo {
  /// `-UITestsCollaborative`: Alex's "Sunday kitchen", shared and collaborative, so the demo account adds to it, moves
  /// and removes its songs as its owner does. Sam added Sour Times; Alex the rest (the owner's say nothing of it).
  static let sundayKitchen: PlaylistDetail = {
    let songs: [(track: Track, addedBy: String?)] = [(protectionTracks[0], nil), (dummyTracks[1], "Sam"), (protectionTracks[1], nil)]
    return PlaylistDetail(
      id: 900, name: "Sunday kitchen", description: "Whatever’s cooking", trackCount: songs.count,
      duration: songs.reduce(0) { $0 + $1.track.duration },
      cover: PlaylistCoverInfo(
        url: "/art/playlist/900?v=demo", layout: .horizon, variant: 2, frozen: true, stale: false, energy: 0.55, styles: [],
        analyzed: songs.count, total: songs.count, pending: false),
      updatedAt: when, owner: "Alex", shared: true, mine: false, collaborative: true, canEdit: true,
      items: songs.enumerated().map { index, song in
        PlaylistItem(
          itemId: 501 + index, recordingId: song.track.recordingId, title: song.track.title, artistName: song.track.artistName,
          albumTitle: song.track.albumTitle, addedAt: when, addedBy: song.addedBy, track: song.track)
      })
  }()
}
