import PlayarrAPI

extension ArtistDetail {
  /// The artist's own picture, if there is one. The server falls back to their newest album's cover for an artist
  /// without one, which isn't a photo of them: then nil (`artistPhoto` in apps/web/src/pages/Artist.tsx).
  var photo: String? {
    guard let imageUrl, !albums.contains(where: { $0.coverUrl == imageUrl }) else { return nil }
    return imageUrl
  }

  /// What the artist page's header is drawn over: the wide fanart, else their own photo. Nil for a compact header.
  var heroPhoto: String? { fanartUrl ?? photo }

  /// The compact header's circle, for an artist without a photo: their best album cover (the server's pick), else the
  /// first album cover there is. Nil leaves the stand-in: a record's grooves and their initials.
  var roundCover: String? { imageUrl ?? albums.lazy.compactMap(\.coverUrl).first }
}
