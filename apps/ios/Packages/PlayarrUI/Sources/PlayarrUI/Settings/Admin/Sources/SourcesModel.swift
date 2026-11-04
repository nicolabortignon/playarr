import Foundation
import Observation
import PlayarrAPI

/// Settings → Sources: where the library comes from, in priority order. Polled every 2 s while a source
/// syncs or matches, every 30 s otherwise; when a sync finishes, everything showing the library is refreshed.
@MainActor @Observable
public final class SourcesModel {
  public private(set) var sources: [SourceInfo] = []
  /// False for an account that may not change sources (the server says so).
  public private(set) var canEdit = false
  public private(set) var loaded = false
  /// Why the list couldn't be loaded (the last try).
  public private(set) var loadError: String?
  /// Why the last change failed: the server's message.
  public var error: String?
  /// Sources with a "Match again" on its way (the button waits for it).
  public private(set) var rematching: Set<Int> = []

  @ObservationIgnored let api: any APISending
  @ObservationIgnored private let clock: any Clock<Duration>
  @ObservationIgnored private let libraryChanged: @MainActor () -> Void
  @ObservationIgnored private var wasSyncing = false

  public init(api: any APISending, clock: any Clock<Duration> = ContinuousClock(), libraryChanged: @escaping @MainActor () -> Void = {}) {
    self.api = api
    self.clock = clock
    self.libraryChanged = libraryChanged
  }

  /// Playarr connects to one Lidarr.
  public var hasLidarr: Bool { sources.contains { $0.kind == .lidarr } }
  /// The AcoustID key matters only with a folder source.
  public var hasFolder: Bool { sources.contains { $0.kind == .folder } }

  var pollInterval: Duration { sources.contains { $0.syncing || $0.matching > 0 } ? .seconds(2) : .seconds(30) }

  /// Loads, then follows the sources while the panel is on screen (`.task { await model.poll() }`).
  public func poll() async {
    await Polling.run(clock: clock, interval: { [weak self] in self?.pollInterval }) { [weak self] in await self?.load() }
  }

  public func load() async {
    do {
      apply(try await api.send(API.Settings.sources()))
      loadError = nil
    } catch {
      loadError = failureText(error)
    }
  }

  /// A drag in the list: shown at once, then saved (PUT …/order) when the order really changed.
  public func move(fromOffsets offsets: IndexSet, toOffset destination: Int) async {
    let before = sources
    var list = sources
    let moving = offsets.map { list[$0] }
    for index in offsets.sorted(by: >) { list.remove(at: index) }
    list.insert(contentsOf: moving, at: destination - offsets.filter { $0 < destination }.count)
    guard list.map(\.id) != before.map(\.id) else { return }
    sources = list
    do {
      apply(try await api.send(API.Settings.reorderSources(ids: list.map(\.id))))
    } catch {
      self.error = failureText(error)
      sources = before
      await load()
    }
  }

  /// After the question; its songs leave every list, so everything is refreshed.
  public func remove(_ source: SourceInfo) async {
    await act { try await api.send(API.Settings.removeSource(id: source.id)) }
    libraryChanged()
  }

  public func rescan(_ source: SourceInfo) async {
    await act { try await api.send(API.Settings.rescanSource(id: source.id)) }
  }

  /// "Match again": every album of a folder source is matched on MusicBrainz again.
  public func rematch(_ source: SourceInfo) async {
    rematching.insert(source.id)
    defer { rematching.remove(source.id) }
    await act { try await api.send(API.Settings.rematchSource(id: source.id)) }
  }

  /// A source was added or changed in its form.
  public func saved() async {
    await load()
  }

  private func act(_ call: () async throws -> NoContent) async {
    error = nil
    do {
      _ = try await call()
    } catch {
      self.error = failureText(error)
    }
    await load()
  }

  private func apply(_ response: SourcesResponse) {
    sources = response.sources
    canEdit = response.canEdit
    loaded = true
    let syncing = response.sources.contains(where: \.syncing)
    if wasSyncing, !syncing { libraryChanged() }
    wasSyncing = syncing
  }
}
