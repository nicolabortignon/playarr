import Foundation
import Observation
import PlayarrAPI

/// How loud each song is, as far as the server has measured (`POST /api/levels`), for even volume. As
/// apps/web/src/player/levels.ts: songs not known are asked about at most every 15 s (measuring one takes a second or
/// two), at most 50 to a request.
@MainActor @Observable
public final class LevelStore {
  public static let retryInterval: TimeInterval = 15
  public static let batchSize = 50

  public private(set) var levels: [String: TrackLevel] = [:]

  @ObservationIgnored private var asked: [String: Date] = [:]
  @ObservationIgnored private let fetch: @Sendable ([String]) async throws -> [String: TrackLevel]
  @ObservationIgnored private let now: () -> Date

  public init(now: @escaping () -> Date = Date.init, fetch: @escaping @Sendable ([String]) async throws -> [String: TrackLevel]) {
    self.fetch = fetch
    self.now = now
  }

  /// Learn the levels of these songs, unless known or asked lately.
  public func load(_ tracks: [Track?]) async {
    let at = now()
    var seen = Set<String>()
    let ids = tracks.compactMap { $0?.recordingId }.filter {
      seen.insert($0).inserted && levels[$0] == nil && at.timeIntervalSince(asked[$0] ?? .distantPast) > Self.retryInterval
    }
    guard !ids.isEmpty else { return }
    for id in ids { asked[id] = at }
    for start in stride(from: 0, to: ids.count, by: Self.batchSize) {
      let batch = Array(ids[start..<min(start + Self.batchSize, ids.count)])
      do {
        let found = try await fetch(batch)
        levels.merge(found) { _, new in new }
      } catch {
        for id in batch { asked[id] = nil }
      }
    }
  }

  /// The gain (dB) a song plays at with even volume on: nil when off or not measured yet (it plays as it is).
  public func gainDb(for track: Track, in queue: QueueState, enabled: Bool) -> Double? {
    guard enabled, let level = levels[track.recordingId] else { return nil }
    return JoinRules.levelDb(track, level, in: queue)
  }
}
