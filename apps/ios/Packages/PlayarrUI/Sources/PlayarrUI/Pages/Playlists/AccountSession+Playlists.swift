import PlayarrAPI
import PlayarrPlayer

extension AccountSession {
  /// Opens "Add to playlist" for these songs (none: "New playlist"), from any screen.
  public func addToPlaylist(_ tracks: [Track]) { picking = PlaylistPick(tracks: tracks) }

  /// Queue → "Save as playlist": the song playing, then what's up next in play order.
  static func queueToSave(_ queue: QueueState) -> [Track] {
    guard let current = queue.currentTrack else { return [] }
    return [current] + queue.order.dropFirst(queue.pos + 1).map { queue.queue[$0] }
  }
}

extension AccountSession {
  /// Favorites, playlists and mixes asked for again (pull to refresh on Home and Library).
  func refreshListening() async {
    async let favorites: Void = favorites.load()
    async let playlists: Void = playlists.load()
    async let mixes: Void = mixes.load()
    _ = await (favorites, playlists, mixes)
  }
}
