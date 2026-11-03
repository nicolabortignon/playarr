import Foundation
import PlayarrAPI

/// A server in memory answering with the demo library (`Demo`): what the UI tests browse (`-UITestsDemo`).
public struct DemoAPI: APISending {
  private let answers: [String: any Encodable & Sendable]
  /// Favorites and playlists change as on a real server (phase 6).
  private let state = DemoState()

  public init() {
    answers = Dictionary(Demo.routes.map { ("\($0.method.rawValue) \($0.path)", $0.answer) }, uniquingKeysWith: { _, last in last })
  }

  public func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T {
    let answer: any Encodable & Sendable
    if let remembered = try state.answer(endpoint.method, endpoint.path, query: endpoint.query, body: try endpoint.bodyData()) {
      answer = remembered
    } else if endpoint.method == .get, endpoint.path == "/api/search" {
      answer = Demo.search(endpoint.query.first { $0.name == "q" }?.value ?? "")
    } else if let known = answers["\(endpoint.method.rawValue) \(endpoint.path)"] {
      answer = known
    } else {
      throw APIError.server(status: 404, message: "Not found")
    }
    return try APIClient.decode(T.self, from: try JSONEncoder().encode(answer))
  }
}
