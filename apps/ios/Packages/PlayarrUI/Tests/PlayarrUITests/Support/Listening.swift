import PlayarrAPI
@testable import PlayarrUI

/// Playlists, mixes and stats for the phase 6 tests, built from the demo library's songs (Angel, Risingson,
/// Inertia Creeps, …), with only what each test cares about to say.
enum Listening {
  static let angel = Demo.mezzanineTracks[0]
  static let risingson = Demo.mezzanineTracks[1]
  static let inertia = Demo.mezzanineTracks[2]

  static func cover(pending: Bool = false, layout: CoverLayout = .ridges, variant: Int = 0) -> PlaylistCoverInfo {
    PlaylistCoverInfo(
      url: "/art/playlist/5?v=1", layout: layout, variant: variant, frozen: !pending, stale: false, energy: 0.5, styles: [],
      analyzed: pending ? 1 : 3, total: 3, pending: pending)
  }

  /// A playlist item: its id, and the song when the viewer's library has it.
  static func item(_ itemId: Int, _ track: Track?) -> PlaylistItem {
    PlaylistItem(
      itemId: itemId, recordingId: track?.recordingId ?? "rec-gone-\(itemId)", title: track?.title ?? "Gone \(itemId)",
      artistName: "Massive Attack", albumTitle: "Mezzanine", addedAt: "2026-11-03T10:00:00.000Z", track: track)
  }

  /// Angel, Risingson and Inertia Creeps as items 1, 2 and 3.
  static let three = [item(1, angel), item(2, risingson), item(3, inertia)]

  static func playlist(
    _ id: Int = 5, _ name: String = "Road trip", items: [PlaylistItem] = [], mine: Bool = true, shared: Bool = false,
    owner: String = "Demo", pending: Bool = false
  ) -> PlaylistDetail {
    PlaylistDetail(
      id: id, name: name, description: "", trackCount: items.count, duration: items.compactMap(\.track).reduce(0) { $0 + $1.duration },
      cover: cover(pending: pending), updatedAt: "2026-11-03T10:00:00.000Z", owner: owner, shared: shared, mine: mine, items: items)
  }

  static func summary(_ detail: PlaylistDetail) -> PlaylistSummary {
    PlaylistSummary(
      id: detail.id, name: detail.name, description: detail.description, trackCount: detail.trackCount, duration: detail.duration,
      cover: detail.cover, updatedAt: detail.updatedAt, owner: detail.owner, shared: detail.shared, mine: detail.mine)
  }

  static func mix(refreshesAt: String = "2026-11-03T12:00:00.000Z", tracks: [Track] = []) -> MixDetail {
    MixDetail(
      key: "vibes", kind: .vibes, title: "Your vibes", subtitle: "Massive Attack and more", description: "Songs you play the most",
      trackCount: tracks.count, duration: tracks.reduce(0) { $0 + $1.duration }, covers: [], hue: 210,
      generatedAt: "2026-11-03T10:00:00.000Z", refreshesAt: refreshesAt, tracks: tracks)
  }

  static func summary(_ mix: MixDetail) -> MixSummary {
    MixSummary(
      key: mix.key, kind: mix.kind, title: mix.title, subtitle: mix.subtitle, description: mix.description, trackCount: mix.trackCount,
      duration: mix.duration, covers: mix.covers, hue: mix.hue, generatedAt: mix.generatedAt, refreshesAt: mix.refreshesAt)
  }

  static func stats(range: String = "month", plays: Int = 40, years: [Int] = [2026, 2025]) -> ListeningStats {
    ListeningStats(
      range: range, to: "2026-11-03T10:00:00.000Z", minutes: 95, plays: plays, songs: 37, artists: 12, days: 9, newArtists: 1234,
      longestStreak: 1, topArtists: [.init(artist: Demo.artist, plays: 20, minutes: 80)], topAlbums: [],
      topTracks: [.init(track: angel, plays: 5), .init(track: risingson, plays: 3)], topGenres: [],
      hours: Array(repeating: 0, count: 24), weekdays: Array(repeating: 0, count: 7), years: years)
  }
}
