import Foundation
import Synchronization

/// Downloads' files over URLSession download tasks. `background` is the app's one background session: its tasks go
/// on with the app suspended or closed, the system relaunches the app to hand over what finished
/// (`handleEventsForBackgroundURLSession` in the app delegate), and it waits for a connection and resumes by itself.
/// One file at a time (`httpMaximumConnectionsPerHost = 1`), never discretionary; each request says whether mobile
/// data may be used (Settings → Playback → "Allow downloads on mobile data").
public final class URLSessionTransport: NSObject, URLSessionDownloadDelegate, DownloadTransport, Sendable {
  public static let backgroundIdentifier = "me.tracklistme.playarr.downloads"

  /// The app's background session. Made at launch by the app delegate, so a relaunch reconnects to its tasks.
  public static let background = URLSessionTransport(configuration: .background(withIdentifier: backgroundIdentifier))

  private struct State {
    var session: URLSession?
    var handler: (@Sendable (TransportEvent) -> Void)?
    /// Events from before there was a handler (a relaunch), handed over when one is set.
    var early: [TransportEvent] = []
    var eventsFinished: (@Sendable () -> Void)?
  }

  private let base: URL
  private let state = Mutex(State())

  /// `base`: where jobs' paths start (`Application Support/Playarr/`).
  public init(configuration: URLSessionConfiguration, base: URL = OfflineFolder.applicationBase) {
    self.base = base
    configuration.isDiscretionary = false
    configuration.sessionSendsLaunchEvents = true
    configuration.httpMaximumConnectionsPerHost = 1
    configuration.allowsCellularAccess = true  // each request decides
    super.init()
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    state.withLock { $0.session = session }
  }

  public func setHandler(_ handler: @escaping @Sendable (TransportEvent) -> Void) {
    let early = state.withLock { s in
      s.handler = handler
      defer { s.early = [] }
      return s.early
    }
    for event in early { handler(event) }
  }

  public func start(_ job: TransportJob) {
    guard let session = state.withLock({ $0.session }) else { return }
    let task = job.resumeData.map { session.downloadTask(withResumeData: $0) } ?? session.downloadTask(with: job.request)
    task.taskDescription = job.id
    task.resume()
  }

  public func cancel(_ id: String) {
    guard let session = state.withLock({ $0.session }) else { return }
    Task {
      for task in await session.allTasks where task.taskDescription == id { task.cancel() }
    }
  }

  public func running() async -> Set<String> {
    guard let session = state.withLock({ $0.session }) else { return [] }
    return Set(await session.allTasks.filter { $0.state == .running || $0.state == .suspended }.compactMap(\.taskDescription))
  }

  /// The system relaunched the app for this session: `done` (its completion handler) runs once every event is in.
  public func whenEventsFinish(_ done: @escaping @Sendable () -> Void) {
    state.withLock { $0.eventsFinished = done }
  }

  private func emit(_ event: TransportEvent) {
    let handler = state.withLock { s -> (@Sendable (TransportEvent) -> Void)? in
      if s.handler == nil { s.early.append(event) }
      return s.handler
    }
    handler?(event)
  }

  // MARK: URLSessionDownloadDelegate

  public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    guard let id = downloadTask.taskDescription else { return }
    emit(TransportFiles.finish(id: id, location: location, response: downloadTask.response, base: base))
  }

  public func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    guard let id = downloadTask.taskDescription else { return }
    emit(.progress(id: id, written: totalBytesWritten, expected: totalBytesExpectedToWrite))
  }

  public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    guard let id = task.taskDescription, let event = TransportFiles.complete(id: id, error: error) else { return }
    emit(event)
  }

  public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    let done = state.withLock { s in
      defer { s.eventsFinished = nil }
      return s.eventsFinished
    }
    done?()
  }
}
