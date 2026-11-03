/// An item of a song's ⋯ menu on a playlist page, in the web's order and words. The page adds phase 8's Show metadata
/// and Edit mix points (`TrackLibraryMenuItems`) after them for a song in the library.
public enum PlaylistRowAction: Hashable, Sendable {
  case playNext, addToQueue, addToPlaylist, goToAlbum, goToArtist, remove

  public var label: String {
    switch self {
    case .playNext: "Play next"
    case .addToQueue: "Add to queue"
    case .addToPlaylist: "Add to playlist…"
    case .goToAlbum: "Go to album"
    case .goToArtist: "Go to artist"
    case .remove: "Remove from playlist"
    }
  }

  public var systemImage: String {
    switch self {
    case .playNext: "text.line.first.and.arrowtriangle.forward"
    case .addToQueue: "text.line.last.and.arrowtriangle.forward"
    case .addToPlaylist: "music.note.list"
    case .goToAlbum: "square.stack"
    case .goToArtist: "music.mic"
    case .remove: "xmark"
    }
  }
}
