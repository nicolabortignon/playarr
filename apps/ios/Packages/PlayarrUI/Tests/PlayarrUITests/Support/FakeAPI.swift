import Foundation
import PlayarrAPI
import Synchronization

/// Answers view models' calls from canned JSON and remembers every call, with its body as sorted JSON.
/// Each "METHOD /path" has a queue of answers: they're given in order and the last one repeats.
final class FakeAPI: APISending, @unchecked Sendable {
  struct Call: Equatable, CustomStringConvertible {
    var method: HTTPMethod
    var path: String
    /// The body as JSON with sorted keys; nil without one.
    var body: String?
    var query: [URLQueryItem] = []

    var description: String { "\(method.rawValue) \(path)\(body.map { " \($0)" } ?? "")" }
  }

  private enum Answer {
    case json(String)
    case failure(any Error)
  }

  private struct State {
    var answers: [String: [Answer]] = [:]
    var calls: [Call] = []
    var holds: [String: Gate] = [:]
  }

  private let state = Mutex(State())

  /// From now on, `method path` answers this JSON (an empty string for 204).
  func on(_ method: HTTPMethod, _ path: String, json: String) {
    state.withLock { $0.answers[key(method, path)] = [.json(json)] }
  }

  /// From now on, `method path` answers this value.
  func on(_ method: HTTPMethod, _ path: String, _ value: some Encodable) {
    on(method, path, json: Self.json(value))
  }

  /// Answered after the answers already queued for `method path`.
  func then(_ method: HTTPMethod, _ path: String, _ value: some Encodable) {
    then(method, path, json: Self.json(value))
  }

  func then(_ method: HTTPMethod, _ path: String, json: String) {
    state.withLock { $0.answers[key(method, path), default: []].append(.json(json)) }
  }

  /// From now on, `method path` fails as the server does: a status and its `{ error }` message.
  func fail(_ method: HTTPMethod, _ path: String, status: Int = 400, _ message: String) {
    state.withLock { $0.answers[key(method, path)] = [.failure(APIError.server(status: status, message: message))] }
  }

  /// From now on, `method path` answers only once `gate` is opened (an answer that takes its time), once per opening.
  func hold(_ method: HTTPMethod, _ path: String, until gate: Gate) {
    state.withLock { $0.holds[key(method, path)] = gate }
  }

  var calls: [Call] { state.withLock { $0.calls } }

  func calls(_ method: HTTPMethod, _ path: String) -> [Call] {
    calls.filter { $0.method == method && $0.path == path }
  }

  /// The values of the query parameter `name` sent to `method path`, in order.
  func queries(_ method: HTTPMethod, _ path: String, _ name: String) -> [String] {
    calls(method, path).compactMap { call in call.query.first { $0.name == name }?.value }
  }

  /// The bodies sent to `method path`, in order.
  func bodies(_ method: HTTPMethod, _ path: String) -> [String] {
    calls(method, path).compactMap(\.body)
  }

  func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T {
    let body = try endpoint.bodyData().map(Self.sorted)
    let (answer, hold): (Answer?, Gate?) = state.withLock { state in
      state.calls.append(Call(method: endpoint.method, path: endpoint.path, body: body, query: endpoint.query))
      let key = key(endpoint.method, endpoint.path)
      let hold = state.holds[key]
      guard var queue = state.answers[key], let first = queue.first else { return (nil, hold) }
      if queue.count > 1 {
        queue.removeFirst()
        state.answers[key] = queue
      }
      return (first, hold)
    }
    await hold?.wait()
    switch answer {
    case nil:
      throw APIError.server(status: 404, message: "No fake answer for \(endpoint.method.rawValue) \(endpoint.path)")
    case .failure(let error):
      throw error
    case .json(let text):
      return try JSONDecoder().decode(T.self, from: Data((text.isEmpty ? "{}" : text).utf8))
    }
  }

  private func key(_ method: HTTPMethod, _ path: String) -> String { "\(method.rawValue) \(path)" }

  private static func json(_ value: some Encodable) -> String {
    // swiftlint:disable:next force_try
    String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
  }

  private static func sorted(_ data: Data) -> String {
    guard let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
      let sorted = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes])
    else { return String(decoding: data, as: UTF8.self) }
    return String(decoding: sorted, as: UTF8.self)
  }
}
