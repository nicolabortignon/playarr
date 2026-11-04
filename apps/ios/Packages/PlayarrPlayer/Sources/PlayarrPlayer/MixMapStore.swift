import Foundation
import Observation
import PlayarrAPI

/// Songs' mix maps (`POST /api/mix-maps`, with any cue points set by hand), for cuts on the beat, the transition sheet,
/// Stats for nerds and a press of Next mixed live. As the web: the player asks again for a song after a minute
/// (`player/mixMaps.ts`); what's on screen is asked again every 30 s, ten times at most, while a song has no map yet or
/// one from an older analysis (`mixMapsQuery` in lib/queries.ts), since the server measures those meanwhile.
@MainActor @Observable
public final class MixMapStore {
  public static let fresh: TimeInterval = 60
  public static let pollInterval: TimeInterval = 30
  public static let polls = 10
  public static let batchSize = 50

  public private(set) var maps: [String: MixMapEntry] = [:]

  @ObservationIgnored private var askedAt: [String: Date] = [:]
  @ObservationIgnored private var asking: Set<String> = []
  @ObservationIgnored private var watched: [String] = []
  @ObservationIgnored private var fetches = 0
  @ObservationIgnored private var poll: ScheduledAction?
  @ObservationIgnored private var wanted: [Track] = []
  @ObservationIgnored private var gathering: Task<Void, Never>?
  @ObservationIgnored private let scheduler: any Scheduling
  @ObservationIgnored private let fetch: @Sendable ([String]) async throws -> [String: MixMapEntry]

  public init(scheduler: any Scheduling, fetch: @escaping @Sendable ([String]) async throws -> [String: MixMapEntry]) {
    self.scheduler = scheduler
    self.fetch = fetch
  }

  public func map(_ recordingId: String) -> MixMapEntry? { maps[recordingId] }

  /// Learn these songs' maps unless known within the minute or on their way. The engine never waits for one.
  public func load(_ tracks: [Track?]) async {
    let now = scheduler.now
    var seen = Set<String>()
    let ids = tracks.compactMap { $0?.recordingId }.filter {
      seen.insert($0).inserted && !asking.contains($0) && now.timeIntervalSince(askedAt[$0] ?? .distantPast) > Self.fresh
    }
    await ask(ids, at: now)
  }

  /// A song a list shows its tempo for: asked together with the others that appear in the same moment (a list's rows
  /// appear one by one), through `load`.
  public func want(_ track: Track) {
    wanted.append(track)
    guard gathering == nil else { return }
    gathering = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(50))
      guard let self else { return }
      let tracks = wanted
      wanted = []
      gathering = nil
      await load(tracks)
    }
  }

  /// The songs on screen (Now Playing's next transition, Stats for nerds): asked now unless fresh, then every 30 s while
  /// one isn't current, ten asks at most. Another list starts over; an empty one stops.
  public func watch(_ recordingIds: [String]) {
    guard recordingIds != watched else { return }
    watched = recordingIds
    fetches = 0
    poll?.cancel()
    poll = nil
    guard !recordingIds.isEmpty else { return }
    Task { await refreshWatched(force: false) }
  }

  /// A song's cue points changed (Edit mix points): its map is asked for afresh.
  public func forget(_ recordingId: String) {
    askedAt[recordingId] = nil
  }

  private func refreshWatched(force: Bool) async {
    let ids = watched
    let now = scheduler.now
    let stale = ids.filter { force || now.timeIntervalSince(askedAt[$0] ?? .distantPast) > Self.fresh }
    if !stale.isEmpty {
      fetches += 1
      await ask(ids, at: now)
    }
    guard ids == watched, fetches < Self.polls, ids.contains(where: { (maps[$0]?.version ?? 0) < mixMapVersion }) else { return }
    poll = scheduler.schedule(after: Self.pollInterval) { [weak self] in
      Task { await self?.refreshWatched(force: true) }
    }
  }

  private func ask(_ ids: [String], at now: Date) async {
    guard !ids.isEmpty else { return }
    for id in ids { asking.insert(id) }
    defer { for id in ids { asking.remove(id) } }
    for start in stride(from: 0, to: ids.count, by: Self.batchSize) {
      let batch = Array(ids[start..<min(start + Self.batchSize, ids.count)])
      // Offline or the server busy: asked again next time; meanwhile the songs follow each other the usual way.
      guard let found = try? await fetch(batch) else { continue }
      for id in batch { askedAt[id] = now }
      maps.merge(found) { _, new in new }
    }
  }
}
