import Foundation
import Observation

/// One answer a screen shows: what's cached at once, then the server's when that was missing or stale. A failed ask
/// keeps what's on screen; `error` is set only when there's nothing to show.
@MainActor @Observable
public final class Query<Value: Codable & Sendable> {
  public private(set) var value: Value?
  public private(set) var error: String?
  public private(set) var isFetching = false

  @ObservationIgnored public let key: QueryKey
  @ObservationIgnored private let cache: QueryCache
  @ObservationIgnored private let staleAfter: TimeInterval
  @ObservationIgnored private let fetcher: @Sendable () async throws -> Value

  public init(_ key: QueryKey, cache: QueryCache, staleAfter: TimeInterval = QueryCache.defaultStaleAfter, fetch: @escaping @Sendable () async throws -> Value) {
    self.key = key
    self.cache = cache
    self.staleAfter = staleAfter
    self.fetcher = fetch
    value = cache.cached(key, as: Value.self)?.value
  }

  /// Nothing to show yet, and no error either.
  public var isPending: Bool { value == nil && error == nil }

  /// Asks the server when there's no answer or it's stale.
  public func load() async {
    guard value == nil || cache.isStale(key, after: staleAfter) else { return }
    await refresh()
  }

  /// Asks the server now (pull to refresh, Try again).
  public func refresh() async {
    isFetching = true
    defer { isFetching = false }
    do {
      value = try await cache.fetch(key, fetcher)
      error = nil
    } catch is CancellationError {
      // The screen went away.
    } catch {
      if value == nil { self.error = error.localizedDescription }
    }
  }
}
