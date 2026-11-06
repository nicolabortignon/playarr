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

  /// Its owner's part of the ⋯ menu ("Playlist actions"), after Play next, Add to queue and Add to playlist….
  var ownerActions: [PlaylistAction] {
    guard let playlist, mine else { return [] }
    return [.rename] + (items.isEmpty ? [] : [.newCover]) + [playlist.shared ? .stopSharing : .share, .delete]
  }

  /// A song's own actions, after the song menu's: its owner moves it up or down and removes it.
  func own(at index: Int) -> [MenuAction] {
    guard mine, items.indices.contains(index) else { return [] }
    let item = items[index]
    return SongMenu.moves(index, of: items.count) { [weak self] from, to in Task { await self?.move(from, to: to) } }
      + [MenuAction(.remove, title: "Remove from playlist") { [weak self] in Task { await self?.remove(item) } }]
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

  /// Share with everyone, or Stop sharing: at once, with Undo in the toast, which shares it again ("Stopped sharing
  /// “Late night”"; docs/design.md, "Taking things back").
  func setShared(_ shared: Bool) async {
    guard mine, let name = playlist?.name else { return }
    let id = id
    guard await change({ try await $0.send(API.Playlists.update(id: id, shared: shared)) }), !shared else { return }
    let session = session
    session.toasts.undo("Stopped sharing “\(name)”") { [weak self] in
      Task {
        // The page may have closed since: the playlist is shared again all the same.
        guard let restored = await Self.share(id, session: session) else { return }
        self?.show(restored)
      }
    }
  }

  /// Undo for Stop sharing: shared with everyone again.
  static func share(_ id: Int, session: AccountSession) async -> PlaylistDetail? {
    do {
      let shared = try await session.api.send(API.Playlists.update(id: id, shared: true))
      await session.playlists.settled(shared)
      return shared
    } catch {
      session.toasts.push(error.localizedDescription, tone: .error)
      return nil
    }
  }

  func setCover(layout: CoverLayout, variant: Int) async -> Bool {
    guard mine else { return false }
    let id = id
    return await change { try await $0.send(API.Playlists.setCover(id: id, layout: layout, variant: variant)) }
  }

  /// Remove from playlist: gone from the list at once (back if the server says no), with Undo, which puts the song back
  /// where it was. A song no longer in the library can't be added again, so its removal has no Undo.
  func remove(_ item: PlaylistItem) async {
    guard mine, let playlist, let index = items.firstIndex(where: { $0.itemId == item.itemId }) else { return }
    let after = index > 0 ? items[index - 1].itemId : nil
    items.remove(at: index)
    let id = id
    guard await change({ try await $0.send(API.Playlists.removeItem(id: id, itemId: item.itemId)) }) else {
      show(playlist)
      return
    }
    let message = "Removed “\(item.title)” from “\(playlist.name)”"
    guard item.track != nil else { return session.toasts.push(message) }
    let session = session
    session.toasts.undo(message) { [weak self] in
      Task {
        // The page may have closed since: the playlist is put right all the same.
        guard let restored = await Self.restore(item.recordingId, after: after, at: index, in: id, session: session) else { return }
        self?.show(restored)
      }
    }
  }

  /// Undo for Remove from playlist: the song goes back after the item that came before it (or at its old place, if
  /// that one's gone too). The server adds songs at the end, so it's added, then moved.
  static func restore(_ recordingId: String, after: Int?, at index: Int, in id: Int, session: AccountSession) async -> PlaylistDetail? {
    do {
      let added = try await session.api.send(API.Playlists.addItems(id: id, recordingIds: [recordingId]))
      var order = added.items.map(\.itemId)
      guard let back = order.popLast() else { return added }
      let at = after.map { order.firstIndex(of: $0).map { $0 + 1 } ?? min(index, order.count) } ?? 0
      order.insert(back, at: at)
      let restored = at == order.count - 1 ? added : try await session.api.send(API.Playlists.reorder(id: id, itemIds: order))
      await session.playlists.settled(restored)
      return restored
    } catch {
      session.toasts.push(error.localizedDescription, tone: .error)
      return nil
    }
  }

  /// Adds songs ("Songs like these"' Add). True when they were added.
  func add(_ tracks: [Track]) async -> Bool {
    guard mine, let playlist = await session.playlists.add(tracks, to: id) else { return false }
    show(playlist)
    if playlist.cover.pending { pollRound += 1 }
    return true
  }

  /// Move up and Move down (the menu, VoiceOver): one song one place along, as dragging does, saved at once.
  func move(_ from: Int, to: Int) async {
    guard from != to, items.indices.contains(from), items.indices.contains(to) else { return }
    await move(fromOffsets: [from], toOffset: to > from ? to + 1 : to)
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
