/// One item of a menu (a song's, an album's, a playlist's, a source's): what it says, its glyph from the icon map
/// (docs/design.md, "Icons"), and what it does. Menus come in groups with a line between them (`MenuButtons`), built by
/// `SongMenu`, `PlayableMenu` and `SourceMenu`, so a ⋯, a long press and VoiceOver's actions offer the same items in the
/// same order.
struct MenuAction: Identifiable {
  enum Kind: Hashable, Sendable {
    case play, shuffle, playNext, addToQueue, addToPlaylist, startRadio, goToAlbum, goToArtist, showMetadata, editMixPoints
    case favorite, openQueue, saveAsPlaylist, moveUp, moveDown, remove, rename, newCover, share, stopSharing, delete
    /// A source's (Settings → Sources).
    case syncNow, matchAgain, organizeFiles, edit
  }

  let kind: Kind
  let title: String
  let systemImage: String
  /// It takes something away (Remove, Delete): drawn in red.
  let destructive: Bool
  let perform: @MainActor () -> Void

  var id: Kind { kind }

  /// The item in its usual words and glyph, or in the place's own words ("Remove from queue", "Remove from Favorites").
  init(_ kind: Kind, title: String? = nil, systemImage: String? = nil, perform: @escaping @MainActor () -> Void) {
    self.kind = kind
    self.title = title ?? kind.title
    self.systemImage = systemImage ?? kind.systemImage
    destructive = kind == .remove || kind == .delete
    self.perform = perform
  }
}

extension MenuAction.Kind {
  var title: String {
    switch self {
    case .play: "Play"
    case .shuffle: "Shuffle"
    case .playNext: "Play next"
    case .addToQueue: "Add to queue"
    case .addToPlaylist: "Add to playlist…"
    case .startRadio: "Start radio"
    case .goToAlbum: "Go to album"
    case .goToArtist: "Go to artist"
    case .showMetadata: "Show metadata"
    case .editMixPoints: "Edit mix points"
    case .favorite: "Add to Favorites"
    case .openQueue: "Open queue"
    case .saveAsPlaylist: "Save as playlist"
    case .moveUp: "Move up"
    case .moveDown: "Move down"
    case .remove: "Remove"
    case .rename: "Rename"
    case .newCover: "New cover…"
    case .share: "Share with everyone"
    case .stopSharing: "Stop sharing"
    case .delete: "Delete playlist"
    case .syncNow: "Sync now"
    case .matchAgain: "Match again"
    case .organizeFiles: "Organize files"
    case .edit: "Edit"
    }
  }

  /// SF Symbols, one per concept, as the web's lucide icons (docs/design.md, "Icons").
  var systemImage: String {
    switch self {
    case .play: "play.fill"
    case .shuffle: "shuffle"
    case .playNext: "text.line.first.and.arrowtriangle.forward"
    case .addToQueue: "text.append"
    // A list with a plus, as the web's ListPlus, for every way into a playlist (Save as playlist too): `music.note.list`
    // is a playlist's own glyph.
    case .addToPlaylist: "text.badge.plus"
    case .startRadio: "dot.radiowaves.left.and.right"
    case .goToAlbum: "square.stack"
    case .goToArtist: "music.mic"
    case .showMetadata: "info.circle"
    case .editMixPoints: "waveform"
    case .favorite: "heart"
    case .openQueue: "list.bullet"
    case .saveAsPlaylist: "text.badge.plus"
    case .moveUp: "arrow.up"
    case .moveDown: "arrow.down"
    case .remove: "xmark"
    case .rename: "pencil"
    case .newCover: "paintpalette"
    case .share: "person.2"
    case .stopSharing: "lock"
    case .delete: "trash"
    // Two arrows round, as the web's RefreshCw: "do it again", apart from Try again's one.
    case .syncNow: "arrow.triangle.2.circlepath"
    case .matchAgain: "text.magnifyingglass"
    case .organizeFiles: "folder.badge.gearshape"
    case .edit: "pencil"
    }
  }
}
