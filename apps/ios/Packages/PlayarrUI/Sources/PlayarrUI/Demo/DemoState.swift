import Foundation
import PlayarrAPI
import Synchronization

/// What the demo server remembers between calls: favorites and playlists change, as on a real server, so the UI tests
/// can heart a song, make a playlist, add to it, reorder it and delete it (`-UITestsDemo`). Mixes, recommendations and
/// listening stats answer from the demo library.
final class DemoState: Sendable {
  private struct Library {
    var favorites = [Demo.favorite]
    var playlists = [Demo.lateNight]
    var nextPlaylist = 2
    var nextItem = 100
  }

  private let library = Mutex(Library())

  /// The answer to `method path`, or nil when it isn't one of these.
  func answer(_ method: HTTPMethod, _ path: String, query: [URLQueryItem], body: Data?) throws -> (any Encodable & Sendable)? {
    // "/api/playlists/5/items" → ["playlists", "5", "items"]
    var parts = path.split(separator: "/").map(String.init)
    guard parts.first == "api" else { return nil }
    parts.removeFirst()
    let first = parts.first ?? ""
    let second = parts.count > 1 ? parts[1] : nil
    switch (method, first, parts.count) {
    case (.get, "favorites", 1):
      return library.withLock { $0.favorites }
    case (.put, "favorites", 2):
      guard let track = Demo.tracks.first(where: { $0.recordingId == second }) else { throw Self.notFound }
      library.withLock { state in
        if !state.favorites.contains(where: { $0.recordingId == track.recordingId }) {
          state.favorites.insert(FavoriteTrack(track, favoritedAt: Date().formatted(.iso8601)), at: 0)
        }
      }
      return NoBody()
    case (.delete, "favorites", 2):
      library.withLock { $0.favorites.removeAll { $0.recordingId == second } }
      return NoBody()
    case (.get, "playlists", 1):
      return library.withLock { $0.playlists.map(Self.summary) }
    case (.post, "playlists", 1):
      let input = try JSONDecoder().decode(Input.self, from: body ?? Data("{}".utf8))
      return try library.withLock { state in
        let id = state.nextPlaylist
        state.nextPlaylist += 1
        var playlist = Self.playlist(id: id, name: input.name ?? "", description: input.description ?? "", shared: input.shared ?? false)
        playlist.items = try Self.items(input.recordingIds ?? [], next: &state.nextItem)
        state.playlists.insert(Self.counted(playlist), at: 0)
        return state.playlists[0]
      }
    case (_, "playlists", _):
      guard let id = second.flatMap(Int.init) else { return nil }
      return try playlist(method, id: id, rest: Array(parts.dropFirst(2)), body: body)
    case (.get, "mixes", 2) where second == Demo.mix.key:
      return Demo.mixDetail
    case (.post, "mixes", 3) where second == Demo.mix.key && parts[2] == "regenerate":
      return Demo.mixDetail
    case (.post, "mixes", 3) where second == Demo.mix.key && parts[2] == "save":
      let input = Input(name: "\(Demo.mix.title) · 3 Nov", recordingIds: Demo.mixDetail.tracks.map(\.recordingId))
      return try answer(.post, "/api/playlists", query: [], body: try JSONEncoder().encode(input))
    case (.get, "stats", 1):
      return Demo.stats(range: query.first { $0.name == "range" }?.value ?? "month")
    default:
      return nil
    }
  }

  private func playlist(_ method: HTTPMethod, id: Int, rest: [String], body: Data?) throws -> (any Encodable & Sendable)? {
    try library.withLock { state in
      guard let index = state.playlists.firstIndex(where: { $0.id == id }) else { throw Self.notFound }
      var playlist = state.playlists[index]
      switch (method, rest.first ?? "", rest.count) {
      case (.get, "", 0):
        return playlist
      case (.get, "recommendations", 1):
        // Songs from the library not in the playlist yet, "like" its first song.
        let have = Set(playlist.items.map(\.recordingId))
        let owned = Demo.tracks.filter { !have.contains($0.recordingId) }.prefix(2).map { track in
          RecommendedTrack(
            recordingId: track.recordingId, title: track.title, artistName: track.artistName, albumTitle: track.albumTitle,
            coverUrl: track.coverUrl, because: playlist.items.first?.title ?? "", track: track, artistId: track.artistId)
        }
        return Recommendations(owned: Array(owned), missing: [], seedCount: playlist.items.isEmpty ? 0 : 1)
      case (.delete, "", 0):
        state.playlists.remove(at: index)
        return NoBody()
      case (.patch, "", 0):
        let input = try JSONDecoder().decode(Input.self, from: body ?? Data("{}".utf8))
        playlist.name = input.name ?? playlist.name
        playlist.description = input.description ?? playlist.description
        playlist.shared = input.shared ?? playlist.shared
      case (.post, "items", 1):
        let input = try JSONDecoder().decode(Input.self, from: body ?? Data("{}".utf8))
        playlist.items += try Self.items(input.recordingIds ?? [], next: &state.nextItem)
      case (.delete, "items", 2):
        playlist.items.removeAll { String($0.itemId) == rest[1] }
      case (.put, "order", 1):
        let order = try JSONDecoder().decode(Order.self, from: body ?? Data("{}".utf8)).itemIds
        playlist.items = order.compactMap { id in playlist.items.first { $0.itemId == id } }
      case (.put, "cover", 1):
        let cover = try JSONDecoder().decode(CoverInput.self, from: body ?? Data("{}".utf8))
        playlist.cover.layout = cover.layout
        playlist.cover.variant = cover.variant
      default:
        return nil
      }
      state.playlists[index] = Self.counted(playlist)
      return state.playlists[index]
    }
  }

  private struct Input: Codable {
    var name: String?
    var description: String?
    var recordingIds: [String]?
    var shared: Bool?
  }

  private struct Order: Decodable { var itemIds: [Int] }
  private struct CoverInput: Decodable {
    var layout: CoverLayout
    var variant: Int
  }

  /// A 204: `NoContent` decodes from it.
  private struct NoBody: Encodable, Sendable {}

  private static let notFound = APIError.server(status: 404, message: "Not found")

  private static func items(_ recordingIds: [String], next: inout Int) throws -> [PlaylistItem] {
    try recordingIds.map { id in
      guard let track = Demo.tracks.first(where: { $0.recordingId == id }) else { throw APIError.server(status: 404, message: "Song \(id) is not in the library") }
      next += 1
      return PlaylistItem(
        itemId: next, recordingId: id, title: track.title, artistName: track.artistName, albumTitle: track.albumTitle,
        addedAt: Demo.when, track: track)
    }
  }

  private static func playlist(id: Int, name: String, description: String, shared: Bool) -> PlaylistDetail {
    PlaylistDetail(
      id: id, name: name, description: description, trackCount: 0, duration: 0,
      cover: PlaylistCoverInfo(
        url: "/art/playlist/\(id)?v=demo", layout: .currents, variant: 0, frozen: true, stale: false, energy: 0.4, styles: [], analyzed: 0,
        total: 0, pending: false),
      updatedAt: Demo.when, owner: Demo.account.name, shared: shared, mine: true, items: [])
  }

  private static func counted(_ playlist: PlaylistDetail) -> PlaylistDetail {
    var playlist = playlist
    playlist.trackCount = playlist.items.count
    playlist.duration = playlist.items.compactMap(\.track).reduce(0) { $0 + $1.duration }
    playlist.cover.total = playlist.items.count
    playlist.cover.analyzed = playlist.items.count
    return playlist
  }

  static func summary(_ playlist: PlaylistDetail) -> PlaylistSummary {
    PlaylistSummary(
      id: playlist.id, name: playlist.name, description: playlist.description, trackCount: playlist.trackCount,
      duration: playlist.duration, cover: playlist.cover, updatedAt: playlist.updatedAt, owner: playlist.owner,
      shared: playlist.shared, mine: playlist.mine)
  }
}
