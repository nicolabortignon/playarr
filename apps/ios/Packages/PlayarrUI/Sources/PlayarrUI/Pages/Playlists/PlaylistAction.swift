/// What a playlist's owner can do to it, after a line in its ⋯ menu ("Playlist actions"), in the web's order and words:
/// Rename, New cover…, Share with everyone or Stop sharing, Delete playlist.
enum PlaylistAction: Hashable, Sendable {
  case rename, newCover, share, stopSharing, delete

  /// The menu item it is (its words and glyph).
  var kind: MenuAction.Kind {
    switch self {
    case .rename: .rename
    case .newCover: .newCover
    case .share: .share
    case .stopSharing: .stopSharing
    case .delete: .delete
    }
  }
}
