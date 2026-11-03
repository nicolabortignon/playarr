import PlayarrAPI

extension FavoriteTrack {
  /// A song hearted at `favoritedAt` (ISO 8601), as GET /api/favorites lists it.
  init(_ track: Track, favoritedAt: String) {
    self.init(
      id: track.id, recordingId: track.recordingId, fileId: track.fileId, albumId: track.albumId, artistId: track.artistId,
      title: track.title, artistName: track.artistName, albumTitle: track.albumTitle, trackNumber: track.trackNumber,
      discNumber: track.discNumber, duration: track.duration, explicit: track.explicit, format: track.format, size: track.size,
      streamUrl: track.streamUrl, coverUrl: track.coverUrl, favoritedAt: favoritedAt)
  }
}
