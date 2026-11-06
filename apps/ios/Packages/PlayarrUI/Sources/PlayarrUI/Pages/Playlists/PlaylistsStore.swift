import Foundation
import Observation
import PlayarrAPI

/// The account's playlists and those shared with everyone on the server, most recently changed first. Creating and
/// adding go through here, so every screen sees the change (apps/web/src/lib/queries.ts usePlaylistMutations). Kept in
/// the answer cache under `playlists`, each playlist's songs under `playlist/<id>`.
@MainActor @Observable
public final class PlaylistsStore {
  public private(set) var playlists: [PlaylistSummary]?
  public private(set) var error: String?
  /// Bumped when a change leaves a cover still being drawn: the screens start polling again.
  public private(set) var pollRound = 0

  @ObservationIgnored let api: any APISending
  @ObservationIgnored let queries: QueryCache
  @ObservationIgnored private let toasts: ToastCenter
  @ObservationIgnored private let clock: any Clock<Duration>
  /// While the server is still listening to new songs, covers refine: ask every 4 s.
  static let coverPoll = Duration.seconds(4)

  public init(api: any APISending, queries: QueryCache, toasts: ToastCenter, clock: any Clock<Duration> = ContinuousClock()) {
    self.api = api
    self.queries = queries
    self.toasts = toasts
    self.clock = clock
    playlists = queries.cached(.playlists, as: [PlaylistSummary].self)?.value
  }

  /// Only your own: "Add to playlist" lists these (others' shared playlists can't be changed).
  public var mine: [PlaylistSummary] { playlists?.filter(\.mine) ?? [] }

  public func load() async {
    do {
      let fresh = try await api.send(API.Playlists.list())
      playlists = fresh
      error = nil
      queries.set(fresh, for: .playlists)
    } catch {
      if playlists == nil { self.error = error.localizedDescription }
    }
  }

  /// Asks again every 4 s while a cover is still being drawn, while the screen is up.
  public func poll() async {
    await Polling.run(
      clock: clock,
      interval: { [weak self] in self?.playlists?.contains(where: \.cover.pending) == true ? Self.coverPoll : nil },
      refresh: { [weak self] in await self?.load() })
  }

  /// "New playlist", with these songs (none from Playlists or Library). Toasts as the web does.
  public func create(name: String, tracks: [Track] = []) async -> PlaylistDetail? {
    do {
      let playlist = try await api.send(API.Playlists.create(name: name, recordingIds: tracks.isEmpty ? nil : tracks.map(\.recordingId)))
      toasts.push(
        playlist.trackCount > 0
          ? "Created “\(playlist.name)” with \(Format.plural(playlist.trackCount, "song"))" : "Created “\(playlist.name)”")
      await settled(playlist)
      return playlist
    } catch {
      toasts.push(error.localizedDescription, tone: .error)
      return nil
    }
  }

  /// Adds songs at the end of one of your playlists.
  public func add(_ tracks: [Track], to id: Int) async -> PlaylistDetail? {
    await add(tracks, to: [id]).first
  }

  /// Add to playlist's Add: the songs go at the end of every playlist chosen, all at once, with one toast for those that
  /// took them ("Added “Teardrop” to “Late night” and “Road trip”") and one for any that didn't. The playlists that took
  /// them, in the order given.
  public func add(_ tracks: [Track], to ids: [Int]) async -> [PlaylistDetail] {
    guard !tracks.isEmpty, !ids.isEmpty else { return [] }
    let recordingIds = tracks.map(\.recordingId)
    let api = api
    let results = await withTaskGroup(of: (Int, Result<PlaylistDetail, any Error>).self) { group in
      for (order, id) in ids.enumerated() {
        group.addTask {
          do {
            return (order, .success(try await api.send(API.Playlists.addItems(id: id, recordingIds: recordingIds))))
          } catch {
            return (order, .failure(error))
          }
        }
      }
      var answers: [(Int, Result<PlaylistDetail, any Error>)] = []
      for await answer in group { answers.append(answer) }
      return answers.sorted { $0.0 < $1.0 }.map(\.1)
    }
    let added = results.compactMap { try? $0.get() }
    let failed = results.compactMap { result -> (any Error)? in
      if case .failure(let error) = result { error } else { nil }
    }
    if !added.isEmpty {
      let names = added.count > 2 ? "\(added.count) playlists" : added.map { "“\($0.name)”" }.joined(separator: " and ")
      toasts.push("Added \(TrackActions.named(tracks)) to \(names)")
      for playlist in added {
        queries.set(playlist, for: .playlist(playlist.id))
        if playlist.cover.pending { pollRound += 1 }
      }
      await load()
    }
    if let first = failed.first {
      let reason = first.localizedDescription
      toasts.push(failed.count == 1 ? reason : "Couldn’t add to \(failed.count) playlists: \(reason)", tone: .error)
    }
    return added
  }

  /// The server answered a playlist after a change: keep it for its page, and ask for the list again.
  func settled(_ playlist: PlaylistDetail) async {
    queries.set(playlist, for: .playlist(playlist.id))
    if playlist.cover.pending { pollRound += 1 }
    await load()
  }

  /// A playlist was deleted.
  func removed(_ id: Int) async {
    playlists?.removeAll { $0.id == id }
    await load()
  }
}
