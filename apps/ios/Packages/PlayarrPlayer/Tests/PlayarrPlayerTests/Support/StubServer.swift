import Foundation
import Synchronization

/// A pretend Playarr server for URLSession: serves bytes by path with Range support, in small chunks with a pause
/// between them (so readers really wait), and can break a connection off after some bytes or answer an error.
final class StubServer: URLProtocol, @unchecked Sendable {
  // @unchecked: URLProtocol is an NSObject subclass URLSession drives from its own threads; its only state is the
  // static `routes` and `log` and the `stopped` flag, all behind locks.
  struct Route: Sendable {
    var body: Data
    var status = 200
    var chunk = 16 * 1024
    var pause: Duration = .milliseconds(1)
    /// Break each of the first `breaks` connections off after this many bytes.
    var breakAfter: Int?
    var breaks = 0
    /// Ignore Range and send everything with 200.
    var ignoresRange = false
    /// No answer at all: the server can't be reached.
    var unreachable = false
  }

  static let routes = Mutex<[String: Route]>([:])
  static let log = Mutex<[(path: String, range: String?)]>([])

  static func serve(_ path: String, _ route: Route) { routes.withLock { $0[path] = route } }
  static func requests(_ path: String) -> [String?] { log.withLock { $0.filter { $0.path == path }.map(\.range) } }

  static func configuration() -> URLSessionConfiguration {
    let c = URLSessionConfiguration.ephemeral
    c.protocolClasses = [StubServer.self]
    return c
  }

  static let base = URL(string: "https://playarr.test")!
  static func request(_ path: String) -> URLRequest { URLRequest(url: base.appending(path: path)) }

  private let stopped = Flag()

  override class func canInit(with request: URLRequest) -> Bool { request.url?.host() == "playarr.test" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let client else { return }
    let path = url.path()
    let range = request.value(forHTTPHeaderField: "Range")
    Self.log.withLock { $0.append((path, range)) }
    guard var route = Self.routes.withLock({ $0[path] }) else {
      return respond(client, url, status: 404, headers: [:], body: Data(#"{"error":"Unknown track file"}"#.utf8))
    }
    if route.unreachable { return client.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)) }
    let breakAfter = route.breaks > 0 ? route.breakAfter : nil
    if route.breaks > 0 { Self.routes.withLock { $0[path]?.breaks -= 1 } }
    guard (200..<300).contains(route.status) else {
      return respond(client, url, status: route.status, headers: [:], body: route.body)
    }
    var start = 0
    if let range, !route.ignoresRange, let from = Int(range.dropFirst("bytes=".count).split(separator: "-").first ?? "") {
      start = from
    }
    if start >= route.body.count && start > 0 {
      return respond(client, url, status: 416, headers: ["Content-Range": "bytes */\(route.body.count)"], body: Data())
    }
    let partial = start > 0 || (range != nil && !route.ignoresRange)
    let headers = partial
      ? ["Content-Range": "bytes \(start)-\(route.body.count - 1)/\(route.body.count)", "Content-Length": "\(route.body.count - start)"]
      : ["Content-Length": "\(route.body.count)"]
    route.body = route.body.subdata(in: start..<route.body.count)
    let response = HTTPURLResponse(url: url, statusCode: partial ? 206 : 200, httpVersion: "HTTP/1.1", headerFields: headers)!
    client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    // Boxed: capturing `self` of a nonisolated URLProtocol override trips region-based isolation checking.
    let me = Unchecked(self).value
    let stopped = self.stopped
    Task.detached { [route, client, breakAfter] in
      var sent = 0
      while sent < route.body.count {
        if stopped.isSet { return }
        if let breakAfter, sent >= breakAfter {
          client.urlProtocol(me, didFailWithError: URLError(.networkConnectionLost))
          return
        }
        let end = min(sent + route.chunk, route.body.count, breakAfter.map { max($0, sent + 1) } ?? .max)
        client.urlProtocol(me, didLoad: route.body.subdata(in: sent..<end))
        sent = end
        try? await Task.sleep(for: route.pause)
      }
      client.urlProtocolDidFinishLoading(me)
    }
  }

  override func stopLoading() { stopped.set() }

  private func respond(_ client: any URLProtocolClient, _ url: URL, status: Int, headers: [String: String], body: Data) {
    let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client.urlProtocol(self, didLoad: body)
    client.urlProtocolDidFinishLoading(self)
  }
}

/// Carries a value URLSession itself shares between threads into a task.
struct Unchecked<Value>: @unchecked Sendable {
  let value: Value
  init(_ value: Value) { self.value = value }
}

/// A one-way switch shared with the delivering task.
final class Flag: Sendable {
  private let value = Mutex(false)
  var isSet: Bool { value.withLock { $0 } }
  func set() { value.withLock { $0 = true } }
}

func temporaryDirectory() -> URL {
  let url = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)")
  try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}
