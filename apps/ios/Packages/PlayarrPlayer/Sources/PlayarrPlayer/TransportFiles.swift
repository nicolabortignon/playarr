import Foundation

/// What a download task's delegate does with what arrives, apart from URLSession so it's tested on its own: put the
/// file at its place (before the delegate method returns: URLSession deletes it after), read the server's refusal,
/// keep resume data.
enum TransportFiles {
  /// A finished task's file at `location`, answered with `response`.
  static func finish(id: String, location: URL, response: URLResponse?, base: URL) -> TransportEvent {
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      let body = (try? Data(contentsOf: location)) ?? Data()
      return .failed(id: id, failure: .server(status: status, message: PlaybackError.serverMessage(body)), resumeData: nil)
    }
    guard let destination = destination(of: id, base: base) else {
      return .failed(id: id, failure: .disk("No place for \(id)"), resumeData: nil)
    }
    do {
      let fm = FileManager.default
      try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? fm.removeItem(at: destination)
      try fm.moveItem(at: location, to: destination)
      let bytes = (try? destination.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
      return .finished(id: id, bytes: Int64(bytes))
    } catch {
      return .failed(id: id, failure: .disk(error.localizedDescription), resumeData: nil)
    }
  }

  /// A task that ended with `error` (nil: it finished, and `finish` said so).
  static func complete(id: String, error: (any Error)?) -> TransportEvent? {
    guard let error else { return nil }
    let ns = error as NSError
    let resume = ns.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
    if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled {
      return .failed(id: id, failure: .cancelled, resumeData: resume)
    }
    return .failed(id: id, failure: .network(ns.localizedDescription), resumeData: resume)
  }

  /// Where a job's file goes: its id is a path under `base` (made by the app, but it comes back from the system).
  static func destination(of id: String, base: URL) -> URL? {
    let parts = id.split(separator: "/", omittingEmptySubsequences: false)
    guard parts.count >= 2, !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return nil }
    return base.appending(path: id)
  }
}
