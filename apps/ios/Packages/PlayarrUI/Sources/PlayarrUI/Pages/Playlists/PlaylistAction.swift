/// An item of the playlist's ⋯ menu ("Playlist actions"), in the web's order and words.
public enum PlaylistAction: Hashable, Sendable {
  case rename, playNext, addToQueue, newCover, share, stopSharing, delete

  public var label: String {
    switch self {
    case .rename: "Rename"
    case .playNext: "Play next"
    case .addToQueue: "Add to queue"
    case .newCover: "New cover…"
    case .share: "Share with everyone"
    case .stopSharing: "Stop sharing"
    case .delete: "Delete playlist"
    }
  }

  public var systemImage: String {
    switch self {
    case .rename: "pencil"
    case .playNext: "text.line.first.and.arrowtriangle.forward"
    case .addToQueue: "text.line.last.and.arrowtriangle.forward"
    case .newCover: "paintpalette"
    case .share: "person.2"
    case .stopSharing: "lock"
    case .delete: "trash"
    }
  }
}
