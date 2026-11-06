import PlayarrAPI
import PlayarrPlayer

/// The one song menu (docs/design.md, "Rows, menus and toasts"; apps/web/src/components/menus.ts): the same song shows
/// the same menu in every list, from its ⋯, a long press (or a secondary click) and VoiceOver's actions. Play next · Add
/// to queue · Add to playlist… · Start radio · Go to album · Go to artist · Show metadata · Edit mix points (with DJ mix
/// on); then, after a line, the place's own actions: Move up, Move down, then Remove last. A song no longer in the
/// library has only those.
@MainActor
enum SongMenu {
  /// What changes from one place to another.
  struct Place {
    /// The list is the song's own album: no Go to album.
    var inAlbum = false
    /// It's the song playing (Now Playing): no Play next or Add to queue.
    var playing = false
    /// What Play next does here.
    var playNext = PlayNext.queue
    /// The row leaves its heart out (the queue on a phone): Add to Favorites goes in the menu instead.
    var favorite = false
    /// The place's own actions, after a line: Move up, Move down, then Remove.
    var own: [MenuAction] = []
  }

  enum PlayNext {
    /// Queued after the song playing.
    case queue
    /// Something else that means the same here (Up next moves the song up).
    case instead(@MainActor () -> Void)
    /// Left out (the song is next already).
    case none
  }

  /// The song's items, then the place's own.
  static func groups(_ track: Track?, place: Place = Place(), session: AccountSession) -> [[MenuAction]] {
    guard let track else { return [place.own] }
    var song: [MenuAction] = []
    if !place.playing {
      switch place.playNext {
      case .queue: song.append(MenuAction(.playNext) { session.actions.playNext([track]) })
      case .instead(let playNext): song.append(MenuAction(.playNext, perform: playNext))
      case .none: break
      }
      song.append(MenuAction(.addToQueue) { session.actions.addToQueue([track]) })
    }
    song.append(MenuAction(.addToPlaylist) { session.addToPlaylist([track]) })
    song.append(MenuAction(.startRadio) { Task { await session.actions.startRadio(track) } })
    if !place.inAlbum { song.append(MenuAction(.goToAlbum) { session.actions.goToAlbum(track) }) }
    song.append(MenuAction(.goToArtist) { session.actions.goToArtist(track) })
    let sheets = session.discover.sheets
    song.append(MenuAction(.showMetadata) { sheets.showMetadata(track.id) })
    if sheets.offersMixPoints(for: track) { song.append(MenuAction(.editMixPoints) { sheets.editMixPoints(track) }) }
    if place.favorite { song.append(favorite(track, session: session)) }
    return [song, place.own]
  }

  /// Add to Favorites, or Remove from Favorites.
  static func favorite(_ track: Track, session: AccountSession) -> MenuAction {
    let favorite = session.isFavorite(track)
    return MenuAction(
      .favorite, title: favorite ? "Remove from Favorites" : "Add to Favorites", systemImage: favorite ? "heart.slash" : "heart"
    ) { session.toggleFavorite(track) }
  }

  /// Move up and Move down, in a list that reorders (a playlist, the queue): what dragging does, for the menu and
  /// VoiceOver. `move` takes the place a song is at and the place it goes to.
  static func moves(_ index: Int, of count: Int, move: @escaping @MainActor (Int, Int) -> Void) -> [MenuAction] {
    var items: [MenuAction] = []
    if index > 0 { items.append(MenuAction(.moveUp) { move(index, index - 1) }) }
    if index < count - 1 { items.append(MenuAction(.moveDown) { move(index, index + 1) }) }
    return items
  }

  /// A song of Up next (the queue, Now Playing), `position` places after the one playing (0 plays next), of `count`.
  /// Play next moves it up rather than queueing it again (left out for the song next already); its own actions are
  /// Move up, Move down and Remove from queue, each with Undo where it takes something away.
  static func upNext(_ position: Int, of count: Int, session: AccountSession) -> Place {
    let queue = QueueModel(session: session)
    return Place(
      playNext: position > 0 ? .instead { queue.playNext(position) } : .none,
      own: moves(position, of: count) { queue.move($0, to: $1) } + [MenuAction(.remove, title: "Remove from queue") { queue.remove(position) }])
  }
}
