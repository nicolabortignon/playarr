/// What a playlist's owner can do to it, after a line in its ⋯ menu ("Playlist actions"), in the web's order and words:
/// Rename, New cover…, Share with everyone or Stop sharing, Let others add songs or Stop others adding (a shared one's),
/// Delete playlist.
enum PlaylistAction: Hashable, Sendable {
  case rename, newCover, share, stopSharing, letOthersAdd, stopOthersAdding, delete

  /// The menu item it is (its words and glyph).
  var kind: MenuAction.Kind {
    switch self {
    case .rename: .rename
    case .newCover: .newCover
    case .share: .share
    case .stopSharing: .stopSharing
    case .letOthersAdd: .letOthersAdd
    case .stopOthersAdding: .stopOthersAdding
    case .delete: .delete
    }
  }
}
