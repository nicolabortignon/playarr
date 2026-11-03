import PlayarrAPI

extension AlbumRef {
  /// One key per album, whichever way it's named: its MusicBrainz id, else its artist and title.
  public var requestKey: String {
    mbid ?? releaseMbid ?? "\(TitleKey.of(artistName))|\(TitleKey.of(albumTitle))"
  }
}
