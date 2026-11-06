import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// One playlist's page (apps/web/src/pages/Playlist.tsx). Another account's shared playlist plays like any other but
/// offers no way to change it; only its owner renames, describes, reorders, removes songs, picks a cover, shares or
/// stops sharing, and deletes it. Reordering shows at once and is sent when the song is dropped.
@MainActor @Observable
final class PlaylistModel {
  let id: Int
  private(set) var playlist: PlaylistDetail?
  /// The songs in the order on screen (moved at once by a drag; the server's order otherwise).
  private(set) var items: [PlaylistItem] = []
  private(set) var error: String?
  /// Bumped when a change leaves the cover still being drawn: the page starts polling again.
  private(set) var pollRound = 0
  private(set) var busy = false

  @ObservationIgnored let session: AccountSession
  @ObservationIgnored private let clock: any Clock<Duration>

  init(id: Int, session: AccountSession, clock: any Clock<Duration> = ContinuousClock()) {
    self.id = id
    self.session = session
    self.clock = clock
    if let kept = session.queries.cached(.playlist(id), as: PlaylistDetail.self)?.value { show(kept) }
  }

  // MARK: What the page shows

  /// The viewer owns it: everything that changes it is offered.
  var mine: Bool { playlist?.mine ?? false }
  var playable: [Track] { items.compactMap(\.track) }
  var unavailable: Int { items.count - playable.count }
  var canPickCover: Bool { mine && !items.isEmpty }
  var source: PlaySource? { playlist.map { PlaySource(label: $0.name, href: "/playlists/\($0.id)") } }

  /// "12 songs · 43 min · 2 not in library".
  var facts: String {
    guard let playlist else { return "" }
    var line = "\(Format.plural(items.count, "song")) · \(Format.duration(playlist.duration))"
    if unavailable > 0 { line += " · \(unavailable) not in library" }
    return line
  }

  /// Whose it is, when that's worth saying: the end of the header's meta line.
  var sharing: String? {
    guard let playlist, !playlist.mine || playlist.shared else { return nil }
    return playlist.mine ? "Shared with everyone" : "Shared by \(playlist.owner)"
  }

  /// The ⋯ menu ("Playlist actions").
  var actions: [PlaylistAction] {
    guard let playlist else { return [] }
    var actions: [PlaylistAction] = mine ? [.rename] : []
    if !playable.isEmpty { actions += [.playNext, .addToQueue] }
    if mine && !items.isEmpty { actions.append(.newCover) }
    if mine { actions += [playlist.shared ? .stopSharing : .share, .delete] }
    return actions
  }

  /// A song's ⋯ menu.
  func actions(for item: PlaylistItem) -> [PlaylistRowAction] {
    (item.track == nil ? [] : [.playNext, .addToQueue, .addToPlaylist, .goToAlbum, .goToArtist]) + (mine ? [.remove] : [])
  }

  // MARK: Asking the server

  func load() async {
    do {
      let fresh = try await session.api.send(API.Playlists.get(id: id))
      show(fresh)
      error = nil
      session.queries.set(fresh, for: .playlist(id))
    } catch {
      if playlist == nil { self.error = error.localizedDescription }
    }
  }

  /// Asks again every 4 s while the cover is being drawn, while the page is up.
  func poll() async {
    await Polling.run(
      clock: clock,
      interval: { [weak self] in self?.playlist?.cover.pending == true ? PlaylistsStore.coverPoll : nil },
      refresh: { [weak self] in await self?.load() })
  }

  // MARK: Playing

  func play(shuffle: Bool) {
    guard !playable.isEmpty else { return }
    session.player.play(playable, source: source, shuffle: shuffle)
  }

  /// Play, or Pause and Resume while the queue is this playlist.
  var playState: PlayState { PlayState.of(session.player.queue, href: "/playlists/\(id)") }

  /// The Play button: pause or resume this playlist, or play it from the top, in order.
  func playOrPause() {
    if playState.isCurrent { session.player.togglePlay() } else { play(shuffle: false) }
  }

  /// Tapping a song plays the playlist from there.
  func play(from item: PlaylistItem) {
    guard let track = item.track, let index = playable.firstIndex(of: track) else { return }
    session.player.play(playable, startAt: index, source: source)
  }

  func queue(next: Bool) {
    guard !playable.isEmpty else { return }
    next ? session.actions.playNext(playable) : session.actions.addToQueue(playable)
  }

  // MARK: Changing it (its owner only)

  /// Rename and describe. An empty name cancels, as on the web. True when the page can stop editing.
  func save(name: String, description: String) async -> Bool {
    guard mine, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return true }
    let id = id
    return await change { try await $0.send(API.Playlists.update(id: id, name: name, description: description)) }
  }

  func setShared(_ shared: Bool) async {
    guard mine else { return }
    let id = id
    _ = await change { try await $0.send(API.Playlists.update(id: id, shared: shared)) }
  }

  func setCover(layout: CoverLayout, variant: Int) async -> Bool {
    guard mine else { return false }
    let id = id
    return await change { try await $0.send(API.Playlists.setCover(id: id, layout: layout, variant: variant)) }
  }

  func remove(_ item: PlaylistItem) async {
    guard mine else { return }
    let id = id
    _ = await change { try await $0.send(API.Playlists.removeItem(id: id, itemId: item.itemId)) }
  }

  /// Adds songs ("Songs like these"' Add). True when they were added.
  func add(_ tracks: [Track]) async -> Bool {
    guard mine, let playlist = await session.playlists.add(tracks, to: id) else { return false }
    show(playlist)
    if playlist.cover.pending { pollRound += 1 }
    return true
  }

  /// A drag ended: the songs move at once, and the new order is sent if it differs from the server's. If the server
  /// says no, they go back.
  func move(fromOffsets source: IndexSet, toOffset destination: Int) async {
    guard mine, let playlist else { return }
    items = Self.moved(items, fromOffsets: source, toOffset: destination)
    let order = items.map(\.itemId)
    guard order != playlist.items.map(\.itemId) else { return }
    do {
      let answer = try await session.api.send(API.Playlists.reorder(id: id, itemIds: order))
      show(answer)
      await session.playlists.settled(answer)
    } catch {
      show(playlist)
      session.toasts.push(error.localizedDescription, tone: .error)
    }
  }

  /// Deletes the playlist. True when it's gone (the page goes back).
  func delete() async -> Bool {
    guard mine else { return false }
    do {
      _ = try await session.api.send(API.Playlists.delete(id: id))
      await session.playlists.removed(id)
      return true
    } catch {
      session.toasts.push(error.localizedDescription, tone: .error)
      return false
    }
  }

  /// `items` with the ones at `source` moved before `destination` (an index in the list before the move), as SwiftUI's
  /// `onMove` reports a drop.
  static func moved<T>(_ items: [T], fromOffsets source: IndexSet, toOffset destination: Int) -> [T] {
    let moving = source.map { items[$0] }
    var rest = items.enumerated().filter { !source.contains($0.offset) }.map(\.element)
    rest.insert(contentsOf: moving, at: destination - source.count(in: 0..<destination))
    return rest
  }

  private func change(_ send: (any APISending) async throws -> PlaylistDetail) async -> Bool {
    busy = true
    defer { busy = false }
    do {
      let answer = try await send(session.api)
      show(answer)
      if answer.cover.pending { pollRound += 1 }
      await session.playlists.settled(answer)
      return true
    } catch {
      session.toasts.push(error.localizedDescription, tone: .error)
      return false
    }
  }

  private func show(_ detail: PlaylistDetail) {
    playlist = detail
    items = detail.items
  }
}
