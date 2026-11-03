import Foundation

/// One file for the transport to fetch. `id` is the file's path from `Application Support/Playarr/` (see
/// `OfflineFolder.jobID`): it says where the file goes, and names the job across launches.
public struct TransportJob: Sendable, Equatable {
  public var id: String
  public var request: URLRequest
  /// From an earlier try that broke off (the connection, or the app closed from the switcher).
  public var resumeData: Data?

  public init(id: String, request: URLRequest, resumeData: Data? = nil) {
    self.id = id
    self.request = request
    self.resumeData = resumeData
  }
}

public enum TransportFailure: Error, Sendable, Equatable {
  /// The server said no: its status and `{ error }`.
  case server(status: Int, message: String?)
  /// The connection failed (the system already waited for one and retried).
  case network(String)
  /// Stopped: by us, or by the system when the app was closed from the switcher (then with resume data).
  case cancelled
  /// The file couldn't be put in place (disk full).
  case disk(String)

  /// In words, for Library → Downloads.
  public var reason: String {
    switch self {
    case .server(let status, let message): message ?? "The server answered \(status)"
    case .network(let message): message
    case .cancelled: "Stopped"
    case .disk: OfflineRules.noRoom
    }
  }
}

public enum TransportEvent: Sendable, Equatable {
  case progress(id: String, written: Int64, expected: Int64)
  /// The whole file is at its place.
  case finished(id: String, bytes: Int64)
  case failed(id: String, failure: TransportFailure, resumeData: Data?)

  public var id: String {
    switch self {
    case .progress(let id, _, _), .finished(let id, _), .failed(let id, _, _): id
    }
  }
}

/// What fetches downloads' files: a background URLSession in the app (`URLSessionTransport.background`), so they go
/// on with the app closed; a fake in tests.
public protocol DownloadTransport: AnyObject, Sendable {
  /// Where every job's events go (the active account's `DownloadStore`; the last one set wins). Events that came
  /// before there was a handler (a relaunch) are handed over when it's set.
  func setHandler(_ handler: @escaping @Sendable (TransportEvent) -> Void)
  func start(_ job: TransportJob)
  /// Stops a job; it ends with `.failed(.cancelled)`.
  func cancel(_ id: String)
  /// The jobs under way, as the system knows them (after a relaunch too).
  func running() async -> Set<String>
}
