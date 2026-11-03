import PlayarrAPI

extension Album {
  /// The album part of an album page's answer (AlbumDetail repeats Album's fields).
  public init(_ detail: AlbumDetail) {
    self.init(
      id: detail.id, title: detail.title, artistId: detail.artistId, artistName: detail.artistName, year: detail.year,
      releaseDate: detail.releaseDate, albumType: detail.albumType, secondaryTypes: detail.secondaryTypes, genres: detail.genres,
      duration: detail.duration, trackCount: detail.trackCount, totalTrackCount: detail.totalTrackCount, coverUrl: detail.coverUrl,
      addedAt: detail.addedAt, format: detail.format, mbid: detail.mbid, mayBeIncomplete: detail.mayBeIncomplete)
  }
}
