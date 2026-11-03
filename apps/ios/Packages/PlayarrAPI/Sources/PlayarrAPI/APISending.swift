/// Sends an endpoint and decodes its answer: what screens and view models talk to, so tests can
/// answer them from a fake. `APIClient` is the real one.
public protocol APISending: Sendable {
  func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T
}

extension APIClient: APISending {}
