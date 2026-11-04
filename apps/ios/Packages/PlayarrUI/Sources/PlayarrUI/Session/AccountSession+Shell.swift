import PlayarrAPI

/// Phase 6's favorites and playlists as the shell calls them, in one place: the keyboard's L, the rows' VoiceOver
/// actions, the sidebar's "+" and dropping songs on a playlist.
extension AccountSession {
  public func isFavorite(_ track: Track) -> Bool {
    favorites.isFavorite(track.recordingId)
  }

  public func toggleFavorite(_ track: Track) {
    Task { await favorites.toggle(track) }
  }

  /// Songs dropped on one of your playlists (the toast is phase 6's: Added “Angel” to “Late night”).
  public func add(_ tracks: [Track], to playlist: PlaylistSummary) {
    Task { _ = await playlists.add(tracks, to: playlist.id) }
  }

  /// The sidebar's "+": phase 6's Add to playlist sheet with no songs, which makes a new playlist (the web's
  /// `openPlaylistPicker([])`).
  public func newPlaylist() {
    addToPlaylist([])
  }
}
