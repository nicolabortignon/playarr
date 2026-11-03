import Observation
import PlayarrAPI

/// Phase 8's state for the signed-in account (`AccountSession.discover`): the server's health (does it have Lidarr,
/// may this account request), the requests and the MusicBrainz queue, Discover's short-lived answers, and which of
/// them a change made stale. In the environment of the signed-in app as `DiscoverContext?`.
@MainActor @Observable
public final class DiscoverContext {
  public let api: any APISending
  public private(set) var account: Account
  public private(set) var health: HealthStatus?
  public let requests: RequestsModel
  public let musicBrainz: MusicBrainzStatusModel
  /// Show metadata and Edit mix points.
  public let sheets = TrackSheets()
  /// Bumped when a family of answers goes stale: views reload with `.task(id: context.generation(.discover))`.
  public private(set) var generations: [CacheFamily: Int] = [:]

  @ObservationIgnored private let clock: any Clock<Duration>
  @ObservationIgnored private let forward: @MainActor ([CacheFamily]) -> Void
  @ObservationIgnored let toast: @MainActor (String, Bool) -> Void
  @ObservationIgnored private var searches = TimedCache<DiscoverResults>(maxAge: .seconds(60))
  @ObservationIgnored private var artists = TimedCache<DiscoverArtistDetail>(maxAge: .seconds(60))
  @ObservationIgnored private var similar = TimedCache<[DiscoverArtist]>(maxAge: .seconds(3600))
  @ObservationIgnored private var healthWatch: Task<Void, Never>?

  /// `forward` passes invalidations on to the account's `QueryCache` (phase 4's pages); `toast` shows a message.
  public init(
    api: any APISending, account: Account, clock: any Clock<Duration> = ContinuousClock(), notifier: (any RequestNotifier)? = nil,
    toast: @escaping @MainActor (String, Bool) -> Void, forward: @escaping @MainActor ([CacheFamily]) -> Void = { _ in }
  ) {
    self.api = api
    self.account = account
    self.clock = clock
    self.toast = toast
    self.forward = forward
    musicBrainz = MusicBrainzStatusModel(api: api, clock: clock)
    requests = RequestsModel(api: api, clock: clock, notifier: notifier, toast: toast, invalidate: { _ in })
    requests.invalidate = { [weak self] in self?.invalidate($0) }
  }

  public var gate: RequestGate { RequestGate(health: health, account: account) }

  /// The account changed on the server (its rights, say).
  public func update(_ account: Account) { self.account = account }

  /// Health every minute (as the web) and the requests' own polling, until `stop()`.
  public func start() {
    requests.startPolling()
    healthWatch?.cancel()
    healthWatch = Task { [weak self, clock] in
      while !Task.isCancelled {
        await self?.refreshHealth()
        do { try await clock.sleep(for: .seconds(60)) } catch { return }
      }
    }
  }

  public func stop() {
    requests.stopPolling()
    healthWatch?.cancel()
    healthWatch = nil
  }

  /// Back on screen: the app may have been suspended, so ask at once.
  public func becameActive() {
    Task {
      await refreshHealth()
      await requests.refresh()
    }
  }

  public func refreshHealth() async {
    if let fresh = try? await api.send(API.Server.health()) { health = fresh }
  }

  public func generation(_ family: CacheFamily) -> Int { generations[family, default: 0] }

  /// Marks answers stale here and in the account's cache.
  public func invalidate(_ families: [CacheFamily]) {
    for family in Set(families) {
      generations[family, default: 0] += 1
      switch family {
      case .discover: searches.removeAll()
      case .discoverArtist: artists.removeAll()
      case .similarArtists: similar.removeAll()
      case .health: Task { await refreshHealth() }
      case .requests: Task { await requests.refresh() }
      default: break
      }
    }
    forward(families)
  }

  /// Music not in the library matching `query`, kept a minute.
  public func discover(_ query: String) async throws -> DiscoverResults {
    if let kept = searches.value(query) { return kept }
    let fresh = try await api.send(API.Discover.search(query))
    searches.store(fresh, for: query)
    return fresh
  }

  /// An artist's MusicBrainz discography, kept a minute.
  public func discoverArtist(_ mbid: String) async throws -> DiscoverArtistDetail {
    if let kept = artists.value(mbid) { return kept }
    let fresh = try await api.send(API.Discover.artist(mbid: mbid))
    artists.store(fresh, for: mbid)
    return fresh
  }

  /// Artists like this one (ListenBrainz): they change slowly, so kept an hour.
  public func similarArtists(_ mbid: String) async throws -> [DiscoverArtist] {
    if let kept = similar.value(mbid) { return kept }
    let fresh = try await api.send(API.Discover.similarArtists(mbid: mbid))
    similar.store(fresh, for: mbid)
    return fresh
  }
}
