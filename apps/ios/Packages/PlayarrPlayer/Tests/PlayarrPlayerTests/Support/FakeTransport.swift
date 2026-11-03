import Foundation
import Synchronization
@testable import PlayarrPlayer

/// The background session, for tests: jobs wait until the test finishes or fails them. Finishing writes the file
/// where the job's id says, as the real delegate does, then tells the handler.
final class FakeTransport: DownloadTransport {
  private struct State {
    var handler: (@Sendable (TransportEvent) -> Void)?
    var running: [String: TransportJob] = [:]
    var started: [TransportJob] = []
    var cancelled: [String] = []
  }

  let base: URL
  private let state = Mutex(State())
  /// Cancelling only notes it: for a file that was already on its way when the job was stopped.
  let holdCancels = Shared(false)

  init(base: URL) { self.base = base }

  /// Every job started, in order.
  var started: [TransportJob] { state.withLock { $0.started } }
  /// The jobs under way, in the order they started.
  var runningIDs: [String] {
    state.withLock { s in
      var seen = Set<String>()
      return s.started.map(\.id).filter { s.running[$0] != nil && seen.insert($0).inserted }
    }
  }
  var cancelled: [String] { state.withLock { $0.cancelled } }

  func setHandler(_ handler: @escaping @Sendable (TransportEvent) -> Void) { state.withLock { $0.handler = handler } }

  func start(_ job: TransportJob) {
    state.withLock {
      $0.running[job.id] = job
      $0.started.append(job)
    }
  }

  func cancel(_ id: String) {
    let hold = holdCancels.value
    let wasRunning = state.withLock { s in
      s.cancelled.append(id)
      return hold ? s.running[id] != nil : s.running.removeValue(forKey: id) != nil
    }
    if wasRunning && !hold { emit(.failed(id: id, failure: .cancelled, resumeData: nil)) }
  }

  func running() async -> Set<String> { state.withLock { Set($0.running.keys) } }

  /// Pretends a job the system had from before a relaunch.
  func pretendRunning(_ id: String) { state.withLock { $0.running[id] = TransportJob(id: id, request: URLRequest(url: URL(string: "https://playarr.test")!)) } }

  func finish(_ id: String, bytes: Int = 1000) {
    let url = base.appending(path: id)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? Data(count: bytes).write(to: url)
    state.withLock { _ = $0.running.removeValue(forKey: id) }
    emit(.finished(id: id, bytes: Int64(bytes)))
  }

  func fail(_ id: String, _ failure: TransportFailure, resumeData: Data? = nil) {
    state.withLock { _ = $0.running.removeValue(forKey: id) }
    emit(.failed(id: id, failure: failure, resumeData: resumeData))
  }

  func progress(_ id: String, written: Int64, expected: Int64) { emit(.progress(id: id, written: written, expected: expected)) }

  private func emit(_ event: TransportEvent) { state.withLock { $0.handler }?(event) }
}
