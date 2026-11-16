import Foundation
import Synchronization

/// One file fetched over HTTP into a local file, from a byte on, readable while it arrives. A connection that breaks
/// is asked again from the byte it stopped at, up to `retries` times in a row (3, as `STREAM_RETRIES` on the web; any
/// bytes arriving start the count again), backing off further each time (`backoff`): a dead spot of a few seconds goes
/// by without the song failing. With a `meter`, how fast the bytes come in is measured for Automatic quality. An encoded stream's
/// download (`endsAtPadding`) ends where its padding starts (`StreamPadding`): the rest isn't fetched.
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
    /// The walk to an encoded stream's padding, through the resource's bytes from its first.
    var padding: StreamPadding?
    /// Measuring: since when, and the bytes since (from the first bytes of each request: the wait for them is the
    /// server's, not the connection's).
    var measuringSince: ContinuousClock.Instant?
    var measuredBytes = 0
  }

  private let state: Mutex<State>
  private let configuration: @Sendable () -> URLSessionConfiguration
  private let retryDelay: Duration
  private let retries: Int
  private let meter: Bandwidth?
  /// Measurements of at least this long go to the meter.
  static let measureEvery: Duration = .milliseconds(500)

  /// The waits before asking again, in `retryDelay`s: 1, 3 and 8 s by default (plan 2 §5).
  static let backoff = [1, 3, 8]

  /// `file` already holding bytes (an earlier, interrupted download) is continued from its end. With `finalFile`,
  /// the file is moved there once complete. `endsAtPadding`: an encoded stream from its first byte, which ends at its
  /// padding.
  public init(
    request: URLRequest, firstByte: Int64 = 0, file: URL, finalFile: URL? = nil, retries: Int = 3,
    retryDelay: Duration = .seconds(1), endsAtPadding: Bool = false, meter: Bandwidth? = nil,
    configuration: @escaping @Sendable () -> URLSessionConfiguration = { .default }
  ) {
    self.meter = meter
    self.request = request
    self.firstByte = firstByte
    self.retryDelay = retryDelay
    self.retries = retries
    self.configuration = configuration
    let existing = (try? FileManager.default.attributesOfItem(atPath: file.path(percentEncoded: false))[.size] as? Int64) ?? 0
    var initial = State(file: file, finalFile: finalFile, received: existing, retriesLeft: retries)
    if endsAtPadding { initial.padding = Self.walk(file, upTo: existing) }
    state = Mutex(initial)
  }

  /// The walk to the padding through the bytes an interrupted download left.
  private static func walk(_ file: URL, upTo length: Int64) -> StreamPadding {
    var padding = StreamPadding()
    guard length > 0, let handle = try? FileHandle(forReadingFrom: file) else { return padding }
    defer { try? handle.close() }
    while padding.start == nil, let data = try? handle.read(upToCount: 256 * 1024), !data.isEmpty { padding.scan(data) }
    return padding
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
    let onFinish = state.withLock { s -> (@Sendable () -> Void)? in
      guard s.session == nil, !s.finished, !s.cancelled, s.failure == nil else { return nil }
      if !FileManager.default.fileExists(atPath: s.file.path(percentEncoded: false)) {
        FileManager.default.createFile(atPath: s.file.path(percentEncoded: false), contents: nil)
      }
      // An interrupted download that got as far as the padding: it's all here.
      if let end = s.padding?.start {
        complete(&s, at: end - firstByte)
        return s.onFinish
      }
      s.session = URLSession(configuration: configuration(), delegate: self, delegateQueue: nil)
      begin(&s)
      return nil
    }
    onFinish?()
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
    s.measuringSince = nil
    s.measuredBytes = 0
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
          if s.padding != nil { s.padding = StreamPadding() }
        }
        if response.expectedContentLength > 0 { s.total = response.expectedContentLength - firstByte }
      }
    }
    completionHandler(.allow)
  }

  public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    var measured: (bytes: Int, seconds: Double)?
    let (ready, onFinish) = state.withLock { s -> ([Waiter], (@Sendable () -> Void)?) in
      guard (200..<300).contains(s.status), !s.finished else {
        if !s.finished { s.errorBody.append(data) }
        return ([], nil)
      }
      var data = data
      if s.skip > 0 {
        let dropped = min(Int64(data.count), s.skip)
        data = data.dropFirst(Int(dropped))
        s.skip -= dropped
      }
      guard !data.isEmpty else { return ([], nil) }
      // An encoded stream's padding: what's before it is the whole file.
      var end: Int64?
      if s.padding != nil {
        s.padding?.scan(data)
        if let start = s.padding?.start {
          end = start - firstByte
          data = data.prefix(Int(max(0, start - firstByte - s.received)))
        }
      }
      do {
        if !data.isEmpty {
          if s.writer == nil {
            s.writer = try FileHandle(forWritingTo: s.file)
            try s.writer?.seekToEnd()
          }
          try s.writer?.write(contentsOf: data)
        }
      } catch {
        s.task?.cancel()  // disk full: ends as a broken connection
        return ([], nil)
      }
      s.received += Int64(data.count)
      // Bytes came: the connection works, and the next break starts the count of retries again.
      s.retriesLeft = retries
      if meter != nil { measured = measure(&s, bytes: data.count, force: end != nil) }
      if let end {
        s.task?.cancel()
        s.session?.invalidateAndCancel()
        s.session = nil
        complete(&s, at: end)
        defer { s.waiters = [] }
        return (s.waiters, s.onFinish)
      }
      let now = s.received
      let (go, stay) = (s.waiters.filter { $0.wanted <= now }, s.waiters.filter { $0.wanted > now })
      s.waiters = stay
      return (go, nil)
    }
    if let measured { meter?.record(bytes: measured.bytes, seconds: measured.seconds) }
    for w in ready { w.continuation.resume() }
    onFinish?()
  }

  /// Adds `bytes` to the measurement under way: one at least `measureEvery` long is handed back, for the meter, and a
  /// new one starts. Called with the lock held.
  private func measure(_ s: inout State, bytes: Int, force: Bool = false) -> (bytes: Int, seconds: Double)? {
    let now = ContinuousClock.now
    guard let since = s.measuringSince else {
      // The first bytes start the clock.
      s.measuringSince = now
      return nil
    }
    s.measuredBytes += bytes
    let elapsed = now - since
    guard elapsed >= Self.measureEvery || (force && elapsed >= .milliseconds(100)) else { return nil }
    let seconds = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
    defer {
      s.measuringSince = now
      s.measuredBytes = 0
    }
    return s.measuredBytes > 0 ? (s.measuredBytes, seconds) : nil
  }

  /// The file is whole at `length` bytes (an encoded stream up to its padding): kept at that, and moved into place.
  /// Called with the lock held; the caller resumes the waiters and calls `onFinish`.
  private func complete(_ s: inout State, at length: Int64) {
    try? s.writer?.close()
    s.writer = nil
    if s.received > length, let handle = try? FileHandle(forWritingTo: s.file) {
      try? handle.truncate(atOffset: UInt64(max(0, length)))
      try? handle.close()
      s.received = max(0, length)
    }
    s.finished = true
    if let final = s.finalFile {
      try? FileManager.default.removeItem(at: final)
      if (try? FileManager.default.moveItem(at: s.file, to: final)) != nil { s.file = final }
    }
  }

  public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    enum Outcome { case done, failed(Failure), retry(after: Duration), nothing }
    var measured: (bytes: Int, seconds: Double)?
    let (outcome, waiters, onFinish) = state.withLock { s -> (Outcome, [Waiter], (@Sendable () -> Void)?) in
      s.task = nil
      if s.cancelled || s.finished { return (.nothing, [], nil) }
      // The last of what came in: a fast download may be over before a measurement is due.
      if meter != nil, error == nil { measured = measure(&s, bytes: 0, force: true) }
      let broken = error != nil || (s.status == 206 && s.total.map { s.received < $0 } == true)
      let outcome: Outcome
      if s.status == 416 && s.received > 0 {
        outcome = .done  // asked from the end: it's all here
      } else if s.status >= 300 {
        outcome = .failed(.server(status: s.status, message: PlaybackError.serverMessage(s.errorBody)))
      } else if broken {
        if s.retriesLeft > 0 {
          let attempt = retries - s.retriesLeft
          s.retriesLeft -= 1
          return (.retry(after: retryDelay * Self.backoff[min(attempt, Self.backoff.count - 1)]), [], nil)
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
    if let measured { meter?.record(bytes: measured.bytes, seconds: measured.seconds) }
    switch outcome {
    case .retry(let wait):
      Task {
        try? await Task.sleep(for: wait)
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
