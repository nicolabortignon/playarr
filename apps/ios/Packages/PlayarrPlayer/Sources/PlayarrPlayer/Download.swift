import Foundation
import Synchronization

/// One file fetched over HTTP into a local file, from a byte on, readable while it arrives. A connection that breaks
/// is asked again from the byte it stopped at, up to `retries` times (3, as `STREAM_RETRIES` on the web).
///
/// URLSession calls the delegate methods on its own queue while readers wait on other tasks, so all state sits in a
/// `Mutex` (a checked `Sendable`, no `@unchecked` needed). Waiting readers are continuations resumed outside the lock.
public final class Download: NSObject, URLSessionDataDelegate, Sendable {
  public enum Failure: Error, Sendable, Equatable {
    /// The connection kept breaking off (retries used up).
    case network
    /// The server answered with an error status and, usually, `{ error }`.
    case server(status: Int, message: String?)
  }

  public let request: URLRequest
  /// The byte of the resource the local file starts at.
  public let firstByte: Int64

  private struct Waiter {
    let id: UUID
    let wanted: Int64
    let continuation: CheckedContinuation<Void, any Error>
  }

  private struct State {
    var file: URL
    var finalFile: URL?
    var received: Int64 = 0
    var total: Int64?
    var finished = false
    var cancelled = false
    var failure: Failure?
    var retriesLeft: Int
    var session: URLSession?
    var task: URLSessionDataTask?
    var writer: FileHandle?
    var status = 0
    var skip: Int64 = 0
    var errorBody = Data()
    var waiters: [Waiter] = []
    var onFinish: (@Sendable () -> Void)?
  }

  private let state: Mutex<State>
  private let configuration: @Sendable () -> URLSessionConfiguration
  private let retryDelay: Duration

  /// `file` already holding bytes (an earlier, interrupted download) is continued from its end. With `finalFile`,
  /// the file is moved there once complete.
  public init(
    request: URLRequest, firstByte: Int64 = 0, file: URL, finalFile: URL? = nil, retries: Int = 3,
    retryDelay: Duration = .seconds(1), configuration: @escaping @Sendable () -> URLSessionConfiguration = { .default }
  ) {
    self.request = request
    self.firstByte = firstByte
    self.retryDelay = retryDelay
    self.configuration = configuration
    let existing = (try? FileManager.default.attributesOfItem(atPath: file.path())[.size] as? Int64) ?? 0
    state = Mutex(State(file: file, finalFile: finalFile, received: existing, retriesLeft: retries))
  }

  public var received: Int64 { state.withLock { $0.received } }
  public var isFinished: Bool { state.withLock { $0.finished } }
  /// Fetching, or waiting to fetch again.
  public var isActive: Bool { state.withLock { !$0.finished && !$0.cancelled && $0.failure == nil && $0.session != nil } }
  public var file: URL { state.withLock { $0.file } }

  public func onFinish(_ action: @escaping @Sendable () -> Void) {
    state.withLock { $0.onFinish = action }
  }

  public func start() {
    state.withLock { s in
      guard s.session == nil, !s.finished, !s.cancelled, s.failure == nil else { return }
      if !FileManager.default.fileExists(atPath: s.file.path()) {
        FileManager.default.createFile(atPath: s.file.path(), contents: nil)
      }
      s.session = URLSession(configuration: configuration(), delegate: self, delegateQueue: nil)
      begin(&s)
    }
  }

  public func cancel() {
    let waiters = state.withLock { s -> [Waiter] in
      s.cancelled = true
      s.task?.cancel()
      s.session?.invalidateAndCancel()
      s.session = nil
      try? s.writer?.close()
      s.writer = nil
      defer { s.waiters = [] }
      return s.waiters
    }
    for w in waiters { w.continuation.resume(throwing: CancellationError()) }
  }

  /// Up to `maxLength` bytes from `offset` of the local file, waiting for them to arrive; empty at the end.
  public func bytes(at offset: Int64, maxLength: Int) async throws -> Data {
    try await wait(for: offset + 1)
    let (file, available) = state.withLock { ($0.file, $0.received - offset) }
    guard available > 0 else { return Data() }
    let handle = try FileHandle(forReadingFrom: file)
    defer { try? handle.close() }
    try handle.seek(toOffset: UInt64(offset))
    return try handle.read(upToCount: min(maxLength, Int(available))) ?? Data()
  }

  /// Returns once the whole file is here.
  public func waitUntilFinished() async throws {
    try await wait(for: .max)
  }

  private func wait(for wanted: Int64) async throws {
    let id = UUID()
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, any Error>) in
        let ready: Result<Void, any Error>? = state.withLock { s in
          if s.received >= wanted || s.finished { return .success(()) }
          if let failure = s.failure { return .failure(failure) }
          if s.cancelled || Task.isCancelled { return .failure(CancellationError()) }
          s.waiters.append(Waiter(id: id, wanted: wanted, continuation: c))
          return nil
        }
        if let ready { c.resume(with: ready) }
      }
    } onCancel: {
      let waiter = state.withLock { s -> Waiter? in
        guard let i = s.waiters.firstIndex(where: { $0.id == id }) else { return nil }
        return s.waiters.remove(at: i)
      }
      waiter?.continuation.resume(throwing: CancellationError())
    }
  }

  /// Asks for the bytes from where the file ends. Called with the lock held.
  private func begin(_ s: inout State) {
    var request = self.request
    let from = firstByte + s.received
    if from > 0 { request.setValue("bytes=\(from)-", forHTTPHeaderField: "Range") }
    s.status = 0
    s.skip = 0
    s.errorBody = Data()
    s.task = s.session?.dataTask(with: request)
    s.task?.resume()
  }

  // MARK: URLSessionDataDelegate

  public func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
  ) {
    let http = response as? HTTPURLResponse
    state.withLock { s in
      s.status = http?.statusCode ?? 0
      if s.status == 206, let range = http?.value(forHTTPHeaderField: "Content-Range"),
        let total = range.split(separator: "/").last.flatMap({ Int64($0) })
      {
        s.total = total - firstByte
      } else if s.status == 200 {
        // The server sent the whole resource rather than the range: drop what's already here or not wanted.
        s.skip = firstByte
        if s.received > 0 {
          try? s.writer?.close()
          s.writer = nil
          try? Data().write(to: s.file)
          s.received = 0
        }
        if response.expectedContentLength > 0 { s.total = response.expectedContentLength - firstByte }
      }
    }
    completionHandler(.allow)
  }

  public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    let ready = state.withLock { s -> [Waiter] in
      guard (200..<300).contains(s.status) else {
        s.errorBody.append(data)
        return []
      }
      var data = data
      if s.skip > 0 {
        let dropped = min(Int64(data.count), s.skip)
        data = data.dropFirst(Int(dropped))
        s.skip -= dropped
      }
      guard !data.isEmpty else { return [] }
      do {
        if s.writer == nil {
          s.writer = try FileHandle(forWritingTo: s.file)
          try s.writer?.seekToEnd()
        }
        try s.writer?.write(contentsOf: data)
      } catch {
        s.task?.cancel()  // disk full: ends as a broken connection
        return []
      }
      s.received += Int64(data.count)
      let now = s.received
      let (go, stay) = (s.waiters.filter { $0.wanted <= now }, s.waiters.filter { $0.wanted > now })
      s.waiters = stay
      return go
    }
    for w in ready { w.continuation.resume() }
  }

  public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    enum Outcome { case done, failed(Failure), retry, nothing }
    let (outcome, waiters, onFinish) = state.withLock { s -> (Outcome, [Waiter], (@Sendable () -> Void)?) in
      s.task = nil
      if s.cancelled { return (.nothing, [], nil) }
      let broken = error != nil || (s.status == 206 && s.total.map { s.received < $0 } == true)
      let outcome: Outcome
      if s.status == 416 && s.received > 0 {
        outcome = .done  // asked from the end: it's all here
      } else if s.status >= 300 {
        outcome = .failed(.server(status: s.status, message: PlaybackError.serverMessage(s.errorBody)))
      } else if broken {
        if s.retriesLeft > 0 {
          s.retriesLeft -= 1
          return (.retry, [], nil)
        }
        outcome = .failed(.network)
      } else {
        outcome = .done
      }
      try? s.writer?.close()
      s.writer = nil
      s.session?.finishTasksAndInvalidate()
      s.session = nil
      if case .failed(let failure) = outcome {
        s.failure = failure
      } else {
        s.finished = true
        if let final = s.finalFile {
          try? FileManager.default.removeItem(at: final)
          if (try? FileManager.default.moveItem(at: s.file, to: final)) != nil { s.file = final }
        }
      }
      defer { s.waiters = [] }
      return (outcome, s.waiters, s.onFinish)
    }
    switch outcome {
    case .retry:
      Task { [retryDelay] in
        try? await Task.sleep(for: retryDelay)
        self.state.withLock { s in if !s.cancelled { self.begin(&s) } }
      }
    case .failed(let failure):
      for w in waiters { w.continuation.resume(throwing: failure) }
    case .done:
      for w in waiters { w.continuation.resume() }
      onFinish?()
    case .nothing:
      break
    }
  }
}
