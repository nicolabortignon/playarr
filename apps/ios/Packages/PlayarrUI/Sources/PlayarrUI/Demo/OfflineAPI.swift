import PlayarrAPI

/// A server that can't be reached: every call fails as the real client does offline. With nothing kept, every
/// page shows its error state (`-UITestsOffline`).
public struct OfflineAPI: APISending {
  public init() {}

  public func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T {
    throw APIError.offline
  }
}
