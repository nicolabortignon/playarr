import PlayarrAPI
import PlayarrPlayer

/// What a song's ⋯ menu and an album's or a playlist's buttons do (apps/web/src/player/actions.ts and radio.ts), with
/// the web's toasts: Play next and Add to queue name what they queued, with Undo.
@MainActor
public struct TrackActions {
  let session: AccountSession

  public init(session: AccountSession) {
    self.session = session
  }

  public func playNext(_ tracks: [Track]) { queue(tracks, next: true) }
  public func addToQueue(_ tracks: [Track]) { queue(tracks, next: false) }

  /// Play next and Add to queue, from any menu. A toast names what was queued ("“Teardrop” plays next"), with Undo that
  /// takes it back out of what's coming. With nothing queued, the songs just play.
  public func queue(_ tracks: [Track], next: Bool) {
    guard !tracks.isEmpty else { return }
    let player = session.player
    let idle = player.queue.pos < 0
    let base = player.queue.queue.count
    next ? player.playNext(tracks) : player.addToQueue(tracks)
    let what = Self.named(tracks)
    if idle {
      session.toasts.push("Playing \(what)")
      return
    }
    let message = next ? "\(what) \(tracks.count == 1 ? "plays" : "play") next" : "Added \(what) to the queue"
    session.toasts.undo(message) { [weak player] in
      if let player { Self.unqueue(tracks, at: base, from: player) }
    }
  }

  /// A song by its title in quotes, or how many: "“Teardrop”", "3 songs".
  static func named(_ tracks: [Track]) -> String {
    tracks.count == 1 ? "“\(tracks[0].title)”" : Format.plural(tracks.count, "song")
  }

  /// Undo for Play next and Add to queue: the songs queued at `base` leave what's coming (not the song playing), while
  /// it's still the same queue.
  static func unqueue(_ tracks: [Track], at base: Int, from player: Player) {
    let q = player.queue
    // Something else has been played since (a new queue reuses the places): leave it alone.
    guard q.pos >= 0, base + tracks.count <= q.queue.count, tracks.indices.allSatisfy({ q.queue[base + $0] == tracks[$0] }) else { return }
    let added = Set(tracks.indices.map { base + $0 })
    player.setUpcoming(q.order.dropFirst(q.pos + 1).filter { !added.contains($0) })
  }

  /// "Start radio" on a song: the song, then songs like it ("<title> radio").
  public func startRadio(_ track: Track) async {
    await session.player.startRadio(track)
  }

  public func goToAlbum(_ track: Track) { session.router.go(.album(track.albumId)) }
  public func goToArtist(_ track: Track) { session.router.go(.artist(track.artistId)) }

  // MARK: Albums and playlists from their cards

  /// An album card's Play or Shuffle: always in order unless shuffled ("Play means in order").
  public func playAlbum(_ id: Int, shuffle: Bool = false) async {
    guard let album = await album(id) else { return }
    session.player.play(album.tracks, source: PlaySource(label: album.title, href: "/albums/\(id)"), shuffle: shuffle)
  }

  /// An album card's Play next or Add to queue.
  public func queueAlbum(_ id: Int, next: Bool) async {
    guard let album = await album(id) else { return }
    queue(album.tracks, next: next)
  }

  /// The album's songs, or nil once a toast has said why they couldn't be had.
  func albumTracks(_ id: Int) async -> [Track]? { await album(id)?.tracks }

  /// A playlist card's Play or Shuffle: its songs in the library, in order unless shuffled.
  public func playPlaylist(_ id: Int, shuffle: Bool = false) async {
    guard let playlist = await playlist(id) else { return }
    let tracks = playlist.items.compactMap(\.track)
    guard !tracks.isEmpty else { return }
    session.player.play(tracks, source: PlaySource(label: playlist.name, href: "/playlists/\(id)"), shuffle: shuffle)
  }

  /// A playlist's songs in the library, as it plays them, or nil once a toast has said why they couldn't be had.
  func playlistTracks(_ id: Int) async -> [Track]? { await playlist(id)?.items.compactMap(\.track) }

  private func album(_ id: Int) async -> AlbumDetail? {
    let api = session.api
    do {
      return try await session.queries.fetch(.album(id)) { try await api.send(API.Library.album(id: id)) }
    } catch {
      session.toasts.push(error.localizedDescription, tone: .error)
      return nil
    }
  }

  private func playlist(_ id: Int) async -> PlaylistDetail? {
    let api = session.api
    do {
      return try await session.queries.fetch(.playlist(id)) { try await api.send(API.Playlists.get(id: id)) }
    } catch {
      session.toasts.push(error.localizedDescription, tone: .error)
      return nil
    }
  }
}

extension AccountSession {
  public var actions: TrackActions { TrackActions(session: self) }
}
