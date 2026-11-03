import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// Your listening: what you played most, and when, for a period; each calendar year has a year in review
/// (apps/web/src/pages/Stats.tsx). The last report stays on screen while the next period loads.
@MainActor @Observable
final class StatsModel {
  struct Period: Hashable, Sendable {
    let range: StatsRange
    let label: String
  }

  static let fixed = [
    Period(range: "month", label: "4 weeks"), Period(range: "halfyear", label: "6 months"),
    Period(range: "year", label: "12 months"), Period(range: "all", label: "All time"),
  ]

  /// Shown when nothing was played in the period.
  static let nothingPlayed =
    "Nothing played in this period yet. Songs count once heard for 30 seconds, from every device that counts its plays (Settings → Playback)."

  private(set) var range: StatsRange
  private(set) var stats: ListeningStats?
  private(set) var error: String?
  private(set) var loading = false

  @ObservationIgnored private let session: AccountSession

  init(range: StatsRange? = nil, session: AccountSession) {
    self.range = range.flatMap { Self.isValid($0) ? $0 : nil } ?? "month"
    self.session = session
    stats = session.queries.cached(.stats(self.range), as: ListeningStats.self)?.value
  }

  /// A calendar year ("2026") rather than a period.
  static func isYear(_ range: StatsRange) -> Bool { range.count == 4 && range.allSatisfy(\.isNumber) }
  static func isValid(_ range: StatsRange) -> Bool { fixed.contains { $0.range == range } || isYear(range) }

  var isYear: Bool { Self.isYear(range) }

  /// The four periods, then each year with history, newest first.
  var periods: [Period] { Self.fixed + (stats?.years ?? []).map { Period(range: String($0), label: String($0)) } }

  func select(_ range: StatsRange) async {
    guard range != self.range, Self.isValid(range) else { return }
    self.range = range
    await load()
  }

  func load() async {
    let asked = range
    loading = true
    defer { loading = false }
    do {
      let api = session.api
      let fresh = try await session.queries.fetch(.stats(asked)) { try await api.send(API.Stats.listening(asked)) }
      guard asked == range else { return }
      stats = fresh
      error = nil
    } catch {
      guard asked == range else { return }
      if stats == nil { self.error = error.localizedDescription }
    }
  }

  /// "Play them", or a tap on one of the top songs.
  func playTop(from index: Int = 0, all: Bool) {
    guard let stats, !stats.topTracks.isEmpty else { return }
    let label = all && isYear ? "Your top songs of \(stats.range)" : "Your top songs"
    session.player.play(
      stats.topTracks.map(\.track), startAt: index, source: PlaySource(label: label, href: "/settings/listening?range=\(stats.range)"))
  }

  /// "37 songs by 12 artists, on 9 days."
  static func summary(_ stats: ListeningStats) -> String {
    "\(Format.plural(stats.songs, "song")) by \(Format.plural(stats.artists, "artist")), on \(Format.plural(stats.days, "day"))."
  }

  /// The four figures under the minutes.
  static func tiles(_ stats: ListeningStats, locale: Locale = .current) -> [(label: String, value: String)] {
    [
      ("Plays", Format.number(stats.plays, locale: locale)),
      ("Longest streak", Format.plural(stats.longestStreak, "day")),
      ("New artists", Format.number(stats.newArtists, locale: locale)),
      ("A day, on average", Format.minutes((stats.minutes / Double(max(1, stats.days))).rounded(), locale: locale)),
    ]
  }
}
