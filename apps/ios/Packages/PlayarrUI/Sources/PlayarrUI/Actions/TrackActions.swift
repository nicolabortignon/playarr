import PlayarrAPI
import PlayarrPlayer

/// What a song's ⋯ menu and an album's buttons do (apps/web/src/player/actions.ts and radio.ts), with the web's toasts.
@MainActor
public struct TrackActions {
  let session: AccountSession

  public init(session: AccountSession) {
    self.session = session
  }

  public func playNext(_ tracks: [Track]) {
    session.player.playNext(tracks)
    session.toasts.push("Playing \(Format.plural(tracks.count, "track")) next")
  }

  public func addToQueue(_ tracks: [Track]) {
    session.player.addToQueue(tracks)
    session.toasts.push("Added \(Format.plural(tracks.count, "track")) to queue")
  }

  /// The song, then songs like it ("<title> radio").
  public func startRadio(_ track: Track) async {
    await session.player.startRadio(track)
  }

  public func goToAlbum(_ track: Track) { session.router.go(.album(track.albumId)) }
  public func goToArtist(_ track: Track) { session.router.go(.artist(track.artistId)) }

  /// An album card's Play or Shuffle: always in order unless shuffled ("Play means in order").
  public func playAlbum(_ id: Int, shuffle: Bool = false) async {
    guard let album = await album(id) else { return }
    session.player.play(album.tracks, source: PlaySource(label: album.title, href: "/albums/\(id)"), shuffle: shuffle)
  }

  /// An album card's Play next or Add to queue.
  public func queueAlbum(_ id: Int, next: Bool) async {
    guard let album = await album(id) else { return }
    next ? playNext(album.tracks) : addToQueue(album.tracks)
  }

  private func album(_ id: Int) async -> AlbumDetail? {
    let api = session.api
    do {
      return try await session.queries.fetch(.album(id)) { try await api.send(API.Library.album(id: id)) }
    } catch {
      session.toasts.push(error.localizedDescription, tone: .error)
      return nil
    }
  }
}

extension AccountSession {
  public var actions: TrackActions { TrackActions(session: self) }
}
