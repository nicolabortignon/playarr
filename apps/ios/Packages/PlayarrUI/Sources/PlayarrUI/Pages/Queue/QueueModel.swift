import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// The queue, as apps/web/src/pages/Queue.tsx and player/actions.ts: the song playing and where it's from, then Up next
/// (drag, or Move up and Move down, to reorder; tap to play from there; Play next; Remove, with Undo), and Clear with
/// Undo. Songs in Up next go by their place among the songs after the one playing: 0 plays next.
@MainActor
struct QueueModel {
  struct Upcoming: Identifiable, Equatable {
    /// The song's index in the player's queue: unique even when a song is queued twice.
    let queueIndex: Int
    let track: Track
    var id: Int { queueIndex }
  }

  let session: AccountSession
  var player: Player { session.player }

  var current: Track? { player.queue.currentTrack }
  var source: PlaySource? { player.queue.source }

  var upcoming: [Upcoming] {
    let q = player.queue
    guard q.pos >= 0 else { return [] }
    return q.order.dropFirst(q.pos + 1).map { Upcoming(queueIndex: $0, track: q.queue[$0]) }
  }

  /// "Up next · 4 songs · 21 min".
  var header: String {
    let songs = upcoming
    guard !songs.isEmpty else { return "Up next" }
    return "Up next · \(Format.plural(songs.count, "song")) · \(Format.duration(songs.reduce(0) { $0 + $1.track.duration }))"
  }

  /// Plays from the `offset`-th song of Up next.
  func play(_ offset: Int) {
    player.jump(to: player.queue.pos + 1 + offset)
  }

  /// Drag and drop in Up next (List's `onMove`): the new order is given to the player when the drag ends.
  func move(from source: IndexSet, to destination: Int) {
    var ids = upcoming.map(\.queueIndex)
    ids.move(fromOffsets: source, toOffset: destination)
    player.setUpcoming(ids)
  }

  /// Move up and Move down (the menu, VoiceOver): one song from one place to another, as dragging does.
  func move(_ from: Int, to: Int) {
    Self.move(from, to: to, in: player)
  }

  /// Swipe or Edit's delete: one song goes with Undo, several at once without.
  func remove(_ offsets: IndexSet) {
    if offsets.count == 1, let offset = offsets.first { return remove(offset) }
    // From the end, so the positions still to remove don't move.
    for offset in offsets.sorted(by: >) { player.remove(at: player.queue.pos + 1 + offset) }
  }

  /// Remove from queue: the song leaves Up next at once, with Undo, which puts it back before the song that came after it
  /// (while it's still the same queue).
  func remove(_ position: Int) {
    let ids = upcoming.map(\.queueIndex)
    guard ids.indices.contains(position) else { return }
    let queueIndex = ids[position]
    let track = player.queue.queue[queueIndex]
    let followedBy = position + 1 < ids.count ? ids[position + 1] : nil
    player.remove(at: player.queue.pos + 1 + position)
    let player = self.player
    session.toasts.undo("Removed “\(track.title)” from the queue") { [weak player] in
      guard let player else { return }
      let q = player.queue
      var coming = Array(q.order.dropFirst(q.pos + 1))
      // A new queue reuses the places; and the song may be back already.
      guard q.pos >= 0, q.queue.indices.contains(queueIndex), q.queue[queueIndex] == track, !coming.contains(queueIndex) else { return }
      let at = followedBy.flatMap { coming.firstIndex(of: $0) } ?? coming.count
      coming.insert(queueIndex, at: at)
      player.setUpcoming(coming)
    }
  }

  /// ⋯ → Play next for a song further down: it moves up to play next (rather than being queued again), with Undo.
  func playNext(_ position: Int) {
    let songs = upcoming
    guard position > 0, songs.indices.contains(position) else { return }
    let song = songs[position]
    move(position, to: 0)
    let player = self.player
    session.toasts.undo("“\(song.track.title)” plays next") { [weak player] in
      guard let player else { return }
      let q = player.queue
      let coming = Array(q.order.dropFirst(q.pos + 1))
      guard q.pos >= 0, let at = coming.firstIndex(of: song.queueIndex), q.queue[song.queueIndex] == song.track else { return }
      Self.move(at, to: min(position, coming.count - 1), in: player)
    }
  }

  /// Clears Up next, with Undo for a mis-tap (only while the same song plays).
  func clear() {
    let ids = upcoming.map(\.queueIndex)
    guard !ids.isEmpty, player.queue.pos >= 0 else { return }
    let playing = player.queue.order[player.queue.pos]
    let song = player.queue.currentTrack?.id
    player.clearUpcoming()
    let player = self.player
    session.toasts.undo("Cleared \(Format.plural(ids.count, "song")) from the queue") { [weak player] in
      guard let player else { return }
      let q = player.queue
      // The same entry of the same queue: a new queue reuses the indices.
      guard q.pos >= 0, q.order[q.pos] == playing, q.currentTrack?.id == song else { return }
      player.setUpcoming(ids + Array(q.order.dropFirst(q.pos + 1)))
    }
  }

  /// One song of Up next from one place to another (both places among the songs after the one playing).
  private static func move(_ from: Int, to: Int, in player: Player) {
    let q = player.queue
    var ids = Array(q.order.dropFirst(q.pos + 1))
    guard q.pos >= 0, from != to, ids.indices.contains(from), ids.indices.contains(to) else { return }
    ids.insert(ids.remove(at: from), at: to)
    player.setUpcoming(ids)
  }
}
