import Foundation
import Observation
import PlayarrAPI

/// How loud each song is, as far as the server has measured (`POST /api/levels`), for even volume. As
/// apps/web/src/player/levels.ts: songs not known are asked about at most every 15 s (measuring one takes a second or
/// two), at most 50 to a request. The levels of the songs heard most lately are kept across launches (`levels.json`), so
/// a song kept as you listen plays leveled offline too; each is asked about again once a launch, online, in case its
/// file was replaced since.
@MainActor @Observable
public final class LevelStore {
  public static let retryInterval: TimeInterval = 15
  public static let batchSize = 50
  /// Levels kept across launches: those of the songs learned most lately (about 100 bytes each).
  public static let keptMax = 3000

  public private(set) var levels: [String: TrackLevel] = [:]

  @ObservationIgnored private var asked: [String: Date] = [:]
  /// Levels read from the last launch's file, not yet asked about again in this one.
  @ObservationIgnored private var unconfirmed: Set<String> = []
  /// The songs whose levels are kept, the most lately learned last.
  @ObservationIgnored private var order: [String] = []
  @ObservationIgnored private let saved: JSONWriter<Kept>?
  @ObservationIgnored private let fetch: @Sendable ([String]) async throws -> [String: TrackLevel]
  @ObservationIgnored private let now: () -> Date

  struct Kept: Codable, Sendable {
    var levels: [String: TrackLevel]
    var order: [String]
  }

  /// `file`: where levels are kept across launches (none: they aren't).
  public init(
    file: URL? = nil, now: @escaping () -> Date = Date.init, fetch: @escaping @Sendable ([String]) async throws -> [String: TrackLevel]
  ) {
    self.fetch = fetch
    self.now = now
    saved = file.map { JSONWriter($0) }
    if let kept = saved?.read() {
      levels = kept.levels
      order = kept.order.filter { kept.levels[$0] != nil }
      unconfirmed = Set(order)
    }
  }

  /// Learn the levels of these songs, unless known (and asked about since launch) or asked lately.
  public func load(_ tracks: [Track?]) async {
    let at = now()
    var seen = Set<String>()
    let ids = tracks.compactMap { $0?.recordingId }.filter {
      seen.insert($0).inserted && (levels[$0] == nil || unconfirmed.contains($0))
        && at.timeIntervalSince(asked[$0] ?? .distantPast) > Self.retryInterval
    }
    guard !ids.isEmpty else { return }
    for id in ids { asked[id] = at }
    for start in stride(from: 0, to: ids.count, by: Self.batchSize) {
      let batch = Array(ids[start..<min(start + Self.batchSize, ids.count)])
      do {
        let found = try await fetch(batch)
        levels.merge(found) { _, new in new }
        unconfirmed.subtract(batch)
        keep(batch.filter { found[$0] != nil })
      } catch {
        for id in batch { asked[id] = nil }
      }
    }
  }

  /// Writes the levels waiting to be kept now (the app going to the background or closing).
  public func flushSaves() { saved?.flush() }

  /// Keeps these songs' levels across launches, as the most lately learned.
  private func keep(_ ids: [String]) {
    guard let saved, !ids.isEmpty else { return }
    let fresh = Set(ids)
    order.removeAll { fresh.contains($0) }
    order += ids
    if order.count > Self.keptMax { order.removeFirst(order.count - Self.keptMax) }
    let kept = Set(order)
    saved.write(Kept(levels: levels.filter { kept.contains($0.key) }, order: order))
  }

  /// Levels known without asking (kept with downloads, for playing offline); levels already known stay.
  public func remember(_ known: [String: TrackLevel]) {
    levels.merge(known) { current, _ in current }
  }

  /// The gain (dB) a song plays at with even volume on: nil when off or not measured yet (it plays as it is).
  public func gainDb(for track: Track, in queue: QueueState, enabled: Bool) -> Double? {
    guard enabled, let level = levels[track.recordingId] else { return nil }
    return JoinRules.levelDb(track, level, in: queue)
  }
}
