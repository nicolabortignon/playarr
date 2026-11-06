import PlayarrAPI

/// Artists like this one (ListenBrainz): those in the library first, then the others (components/SimilarArtists.tsx).
public enum SimilarArtistGroups {
  public static let kicker = "From ListenBrainz"
  public static let failed = "Couldn’t reach ListenBrainz for similar artists"

  public static func make(_ artists: [DiscoverArtist]) -> [(title: String, artists: [DiscoverArtist])] {
    let mine = artists.filter { $0.artistId != nil }
    let others = artists.filter { $0.artistId == nil }
    return [
      ("Similar artists in your library", mine),
      (mine.isEmpty ? "Similar artists" : "More similar artists", others),
    ].filter { !$0.1.isEmpty }
  }
}
