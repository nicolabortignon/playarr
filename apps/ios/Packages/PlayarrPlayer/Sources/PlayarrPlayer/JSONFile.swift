import Foundation

/// A value kept as a JSON file (the queue, unsent play reports), written atomically. Reading a missing or
/// unreadable file gives nil: losing a saved queue beats failing to start.
public struct JSONFile<Value: Codable & Sendable>: Sendable {
  public let url: URL

  public init(_ url: URL) { self.url = url }

  public func read() -> Value? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(Value.self, from: data)
  }

  /// Writes `value`, or removes the file for nil.
  public func write(_ value: Value?) {
    guard let value else {
      try? FileManager.default.removeItem(at: url)
      return
    }
    do {
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try JSONEncoder().encode(value).write(to: url, options: .atomic)
    } catch {
      // Disk full or the folder gone: the next write tries again.
    }
  }
}
