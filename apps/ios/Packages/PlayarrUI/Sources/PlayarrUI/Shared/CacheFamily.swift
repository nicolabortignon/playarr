/// Families of cached answers, named like the web's query keys: what a change on the server makes stale. Passed on to
/// `QueryCache.invalidate(_:)` by name, and counted by `DiscoverContext.generation(_:)` for this phase's views.
public enum CacheFamily: String, Sendable, CaseIterable {
  case albums, artists, artist, album, health, search, discover, requests, recommendations
  case discoverArtist = "discover-artist"
  case similarArtists = "similar-artists"
  case mixMaps = "mix-maps"
  case trackMetadata = "track-metadata"

  /// What a request that became playable changes (useWatchRequests).
  public static let landed: [CacheFamily] = [.albums, .artists, .artist, .health, .search, .discover, .discoverArtist, .recommendations]
  /// What asking for an album changes (useRequestAlbum); the requests themselves are asked for again by their model.
  public static let requested: [CacheFamily] = [.discover, .discoverArtist, .recommendations]
}
