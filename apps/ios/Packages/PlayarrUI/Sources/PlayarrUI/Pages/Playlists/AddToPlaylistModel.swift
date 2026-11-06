import Foundation
import Observation
import PlayarrAPI

/// "Add to playlist" (apps/web/src/components/AddToPlaylistDialog.tsx): your own playlists, each ticked when it already
/// holds every one of the songs (a dash when it holds some), to choose one or several and add the songs to all of them at
/// once; or a new playlist made with the songs. With no songs it's "New playlist".
@MainActor @Observable
final class AddToPlaylistModel {
  /// How much of the songs a playlist holds already.
  enum Holding: Equatable {
    case none
    case some(Int)
    case all
  }

  let tracks: [Track]
  var creating: Bool
  var name = ""
  /// The playlists chosen, in the order they were picked.
  private(set) var chosen: [Int] = []
  private(set) var busy = false
  /// How many of the songs each playlist holds, by its id, once the server has said (`loadHolding()`).
  private(set) var holding: PlaylistsHolding?

  @ObservationIgnored private let store: PlaylistsStore

  init(tracks: [Track], store: PlaylistsStore) {
    self.tracks = tracks
    self.store = store
    creating = tracks.isEmpty
  }

  var title: String {
    switch tracks.count {
    case 0: "New playlist"
    case 1: "Add “\(tracks[0].title)”"
    default: "Add \(tracks.count) songs"
    }
  }

  /// Your own playlists (others' shared ones can't be changed); none when making a new one from nothing.
  var choices: [PlaylistSummary] { tracks.isEmpty ? [] : store.mine }
  var canCreate: Bool { !busy && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  /// How many songs are being added, as the server counts them: each once, however many times it's in the list.
  var songs: Int { Set(tracks.map(\.recordingId)).count }

  /// Asks the server which of your playlists hold the songs already, afresh each time the sheet opens. Without an
  /// answer there are no ticks, and adding works the same.
  func loadHolding() async {
    guard !tracks.isEmpty else { return }
    holding = try? await store.api.send(API.Playlists.holding(recordingIds: tracks.map(\.recordingId)))
  }

  func holds(_ playlist: PlaylistSummary) -> Holding {
    let count = holding?.count(playlist.id) ?? 0
    return count == 0 ? .none : count >= songs ? .all : .some(count)
  }

  /// What a playlist's line says after its songs: "already in it", "2 of 3 already in it".
  func note(_ playlist: PlaylistSummary) -> String? {
    switch holds(playlist) {
    case .none: nil
    case .some(let count): "\(count) of \(songs) already in it"
    case .all: "already in it"
    }
  }

  func isChosen(_ playlist: PlaylistSummary) -> Bool { chosen.contains(playlist.id) }

  /// Chooses a playlist, or lets it go.
  func toggle(_ playlist: PlaylistSummary) {
    if let index = chosen.firstIndex(of: playlist.id) { chosen.remove(at: index) } else { chosen.append(playlist.id) }
  }

  /// The button that adds: "Add", "Add to 2 playlists", "Adding…" meanwhile.
  var addLabel: String {
    if busy, !creating { return "Adding…" }
    return chosen.count > 1 ? "Add to \(chosen.count) playlists" : "Add"
  }

  var canAdd: Bool { !busy && !chosen.isEmpty }

  /// The new playlist, or nil (the server's message is a toast).
  func create() async -> PlaylistDetail? {
    guard canCreate else { return nil }
    busy = true
    defer { busy = false }
    return await store.create(name: name, tracks: tracks)
  }

  /// Adds the songs to every playlist chosen. True when at least one took them (the sheet closes).
  func add() async -> Bool {
    guard canAdd else { return false }
    busy = true
    defer { busy = false }
    let added = await store.add(tracks, to: chosen)
    return !added.isEmpty
  }
}
