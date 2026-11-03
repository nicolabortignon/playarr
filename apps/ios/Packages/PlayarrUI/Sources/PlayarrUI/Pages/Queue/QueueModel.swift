import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// The queue, as apps/web/src/pages/Queue.tsx: the song playing and where it's from, then Up next (drag to reorder,
/// tap to play from there, remove), and Clear with Undo. "Save as playlist" comes with playlists (phase 6).
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

  /// "Up next · 4 tracks · 21 min".
  var header: String {
    let songs = upcoming
    guard !songs.isEmpty else { return "Up next" }
    return "Up next · \(Format.plural(songs.count, "track")) · \(Format.duration(songs.reduce(0) { $0 + $1.track.duration }))"
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

  func remove(_ offsets: IndexSet) {
    // From the end, so the positions still to remove don't move.
    for offset in offsets.sorted(by: >) { player.remove(at: player.queue.pos + 1 + offset) }
  }

  /// ⋯ → Play next (for songs further down).
  func playNext(_ song: Upcoming) {
    player.setUpcoming([song.queueIndex] + upcoming.map(\.queueIndex).filter { $0 != song.queueIndex })
  }

  /// Clears Up next, with Undo for a mis-tap (only while the same song plays).
  func clear() {
    let ids = upcoming.map(\.queueIndex)
    guard !ids.isEmpty, player.queue.pos >= 0 else { return }
    let playing = player.queue.order[player.queue.pos]
    let song = player.queue.currentTrack?.id
    player.clearUpcoming()
    let player = self.player
    session.toasts.push("Cleared \(Format.plural(ids.count, "track"))", action: .init("Undo") {
      let q = player.queue
      // The same entry of the same queue: a new queue reuses the indices.
      guard q.pos >= 0, q.order[q.pos] == playing, q.currentTrack?.id == song else { return }
      player.setUpcoming(ids + Array(q.order.dropFirst(q.pos + 1)))
    })
  }
}
