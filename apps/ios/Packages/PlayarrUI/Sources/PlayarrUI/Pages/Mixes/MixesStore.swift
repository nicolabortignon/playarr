import Foundation
import Observation
import PlayarrAPI

/// Made for you: the account's mixes, asked for in the device's time zone. Each changes on its own schedule (an hour,
/// a day, a week), so while a screen shows them they're asked for again 5 s after the next one is due
/// (apps/web/src/lib/queries.ts useMixes). Kept in the answer cache under `mixes`.
@MainActor @Observable
public final class MixesStore {
  public private(set) var mixes: [MixSummary]?
  public private(set) var error: String?

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let queries: QueryCache
  @ObservationIgnored private let clock: any Clock<Duration>
  @ObservationIgnored let timeZone: TimeZone

  public init(api: any APISending, queries: QueryCache, clock: any Clock<Duration> = ContinuousClock(), timeZone: TimeZone = .current) {
    self.api = api
    self.queries = queries
    self.clock = clock
    self.timeZone = timeZone
    mixes = queries.cached(.mixes, as: [MixSummary].self)?.value
  }

  public func load() async {
    do {
      let fresh = try await api.send(API.Mixes.list(timeZone: timeZone))
      mixes = fresh
      error = nil
      queries.set(fresh, for: .mixes)
    } catch {
      if mixes == nil { self.error = error.localizedDescription }
    }
  }

  /// Asks again when the next mix is due, while the screen is up.
  public func poll() async {
    await Polling.run(
      clock: clock,
      interval: { [weak self] in Self.recheck(due: (self?.mixes ?? []).compactMap { Format.parseDate($0.refreshesAt) }) },
      refresh: { [weak self] in await self?.load() })
  }

  /// How long to wait before asking again: 5 s after the first mix is due, 15 s if that's already past (the server
  /// serves the old ones while it makes the new), a minute when there's nothing to wait for.
  static func recheck(due: [Date], now: Date = Date()) -> Duration {
    guard let first = due.min() else { return .seconds(60) }
    let wait = first.timeIntervalSince(now) + 5
    return wait > 0 ? .milliseconds(Int64((wait * 1000).rounded())) : .seconds(15)
  }
}
