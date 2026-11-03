import Foundation
import Observation
import PlayarrAPI

/// "Add to playlist": make a new playlist with the songs, or add them to one of your own
/// (components/AddToPlaylistDialog.tsx). With no songs it's "New playlist".
@MainActor @Observable
final class AddToPlaylistModel {
  let tracks: [Track]
  var creating: Bool
  var name = ""
  private(set) var busy = false

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

  /// The new playlist, or nil (the server's message is a toast).
  func create() async -> PlaylistDetail? {
    guard canCreate else { return nil }
    busy = true
    defer { busy = false }
    return await store.create(name: name, tracks: tracks)
  }

  /// True when the songs were added.
  func add(to playlist: PlaylistSummary) async -> Bool {
    guard !busy else { return false }
    busy = true
    defer { busy = false }
    return await store.add(tracks, to: playlist.id) != nil
  }
}
