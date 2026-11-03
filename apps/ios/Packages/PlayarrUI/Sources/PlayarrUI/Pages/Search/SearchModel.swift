import Foundation
import Observation
import PlayarrAPI

/// Search, as apps/web/src/pages/Search.tsx: the library's answer (top artist, songs, albums, artists) plus playlist
/// names matched here, accent-insensitively; "Try an artist" while empty. Discover ("Not in your library") is phase 8.
@MainActor @Observable
final class SearchModel {
  /// Songs shown before "Show all".
  static let tracksShown = 6
  /// Artists suggested while the field is empty.
  static let suggestedCount = 24
  static let playlistHitsShown = 8

  var text = ""
  private(set) var results: SearchResults?
  private(set) var searched = ""
  private(set) var isSearching = false
  private(set) var error: String?
  var showAllTracks = false

  let artists: Query<[Artist]>
  let playlists: Query<[PlaylistSummary]>

  @ObservationIgnored private let session: AccountSession

  init(session: AccountSession) {
    self.session = session
    let api = session.api
    artists = Query(.artists, cache: session.queries) { try await api.send(API.Library.artists()) }
    playlists = Query(.playlists, cache: session.queries, staleAfter: 60) { try await api.send(API.Playlists.list()) }
  }

  var query: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

  func loadSuggestions() async {
    await artists.load()
    await playlists.load()
  }

  /// Asks the library for what's typed (the view waits a moment between keystrokes before calling this).
  func search() async {
    let q = query
    showAllTracks = false
    guard !q.isEmpty else {
      results = nil
      searched = ""
      return
    }
    if let hit = session.queries.cached(.search(q), as: SearchResults.self) {
      results = hit.value
      searched = q
    }
    isSearching = true
    defer { isSearching = false }
    do {
      let api = session.api
      let answer = try await session.queries.fetch(.search(q)) { try await api.send(API.Search.library(q)) }
      guard q == query else { return }
      results = answer
      searched = q
      error = nil
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }

  var topArtist: Artist? { results?.artists.first }

  var tracks: [Track] {
    guard let tracks = results?.tracks else { return [] }
    return showAllTracks ? tracks : Array(tracks.prefix(Self.tracksShown))
  }

  /// "Show all 14 tracks", when there are more than six.
  var showAllLabel: String? {
    guard !showAllTracks, let count = results?.tracks.count, count > Self.tracksShown else { return nil }
    return "Show all \(count) tracks"
  }

  /// Playlists whose names match what's typed (matched here, as the server's search doesn't look at them).
  var playlistHits: [PlaylistSummary] {
    let want = Self.fold(query)
    guard !want.isEmpty else { return [] }
    return Array((playlists.value ?? []).filter { Self.fold($0.name).contains(want) }.prefix(Self.playlistHitsShown))
  }

  /// The library has nothing for what was typed.
  var isEmpty: Bool {
    guard let results, !searched.isEmpty else { return false }
    return results.artists.isEmpty && results.albums.isEmpty && results.tracks.isEmpty && playlistHits.isEmpty
  }

  /// "Try an artist": those with the most music.
  var suggestions: [Artist] {
    let all = artists.value ?? []
    return Array(all.sorted { ($0.albumCount, $0.trackCount) > ($1.albumCount, $1.trackCount) }.prefix(Self.suggestedCount))
  }

  /// "All 312 artists", when there are more than the suggestions.
  var allArtistsLabel: String? {
    guard let count = artists.value?.count, count > Self.suggestedCount else { return nil }
    return "All \(count) artists"
  }

  /// Case- and accent-insensitive text, for matching playlist names.
  static func fold(_ text: String) -> String {
    text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
