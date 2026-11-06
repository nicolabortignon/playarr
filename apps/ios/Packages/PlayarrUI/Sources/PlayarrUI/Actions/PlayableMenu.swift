import PlayarrAPI
import PlayarrPlayer

/// The menus of everything you can play (apps/web/src/components/menus.ts): Play next · Add to queue · Add to playlist…
/// first, the same on a page's ⋯ and on a card's long press, where Play and Shuffle come before them (a card has
/// neither button). Then what's the page's own: an album's Go to artist; after a line, a mix's Save as playlist or a
/// playlist owner's Rename, New cover…, Share and Delete.
@MainActor
enum PlayableMenu {
  /// Songs at hand, or to fetch once chosen (an album or a playlist from its card, an artist's songs).
  enum Songs {
    case tracks([Track])
    /// Nil once a toast has said why they couldn't be had.
    case later(@MainActor () async -> [Track]?)
  }

  /// Play next · Add to queue · Add to playlist….
  static func queueItems(_ songs: Songs, session: AccountSession) -> [MenuAction] {
    [
      MenuAction(.playNext) { with(songs) { session.actions.playNext($0) } },
      MenuAction(.addToQueue) { with(songs) { session.actions.addToQueue($0) } },
      MenuAction(.addToPlaylist) { with(songs) { session.addToPlaylist($0) } },
    ]
  }

  /// An album's menu, on its page's ⋯ (`tracks` at hand) and its card's long press (`card`, the songs fetched once
  /// chosen): Play next · Add to queue · Add to playlist… · Go to artist, a card's starting with Play and Shuffle.
  static func album(_ id: Int, artistId: Int, tracks: [Track]? = nil, card: Bool = false, session: AccountSession) -> [[MenuAction]] {
    let actions = session.actions
    let play =
      card
      ? [MenuAction(.play) { Task { await actions.playAlbum(id) } }, MenuAction(.shuffle) { Task { await actions.playAlbum(id, shuffle: true) } }]
      : []
    let songs = tracks.map(Songs.tracks) ?? .later { await actions.albumTracks(id) }
    return [play + queueItems(songs, session: session) + [MenuAction(.goToArtist) { session.router.go(.artist(artistId)) }]]
  }

  /// A playlist's menu, on its page's ⋯ and its card's long press: Play next · Add to queue · Add to playlist… (while
  /// it has songs to play), a card's starting with Play and Shuffle; then, after a line, its owner's actions (`own`).
  static func playlist(_ id: Int, tracks: [Track]? = nil, card: Bool = false, own: [MenuAction] = [], session: AccountSession) -> [[MenuAction]] {
    let actions = session.actions
    let play =
      card
      ? [
        MenuAction(.play) { Task { await actions.playPlaylist(id) } },
        MenuAction(.shuffle) { Task { await actions.playPlaylist(id, shuffle: true) } },
      ]
      : []
    let songs = tracks.map(Songs.tracks) ?? .later { await actions.playlistTracks(id) }
    let queue = tracks?.isEmpty == true ? [] : queueItems(songs, session: session)
    return [play + queue, own]
  }

  /// Runs `use` with the songs: at once when they're at hand, else once they're fetched (never with none).
  private static func with(_ songs: Songs, _ use: @escaping @MainActor ([Track]) -> Void) {
    switch songs {
    case .tracks(let tracks):
      use(tracks)
    case .later(let fetch):
      Task {
        guard let tracks = await fetch(), !tracks.isEmpty else { return }
        use(tracks)
      }
    }
  }
}
