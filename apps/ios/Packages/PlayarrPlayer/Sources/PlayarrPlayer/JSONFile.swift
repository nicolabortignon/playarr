import Foundation
import Synchronization

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

/// A `JSONFile` written off the main thread: the newest value a moment after the last change, so a burst of changes is
/// one write, and encoding a queue of 10,000 songs no longer holds up the main thread at every change (plan 3 §2).
/// `flush` writes what's waiting at once (the app going to the background or closing, the account switched away from).
public final class JSONWriter<Value: Codable & Sendable>: Sendable {
  public let file: JSONFile<Value>
  private let delay: TimeInterval
  private let queue = DispatchQueue(label: "playarr.json-writer", qos: .utility)
  /// The value waiting to be written (`.some(nil)`: the file to be removed); nil when nothing is.
  private let pending = Mutex<Value??>(nil)

  public init(_ url: URL, delay: TimeInterval = 1) {
    file = JSONFile(url)
    self.delay = delay
  }

  public func read() -> Value? { file.read() }

  /// Writes `value` (nil removes the file) in a moment, unless a later one comes first.
  public func write(_ value: Value?) {
    let first = pending.withLock { pending in
      defer { pending = .some(value) }
      return pending == nil
    }
    guard first else { return }
    queue.asyncAfter(deadline: .now() + delay) { [self] in writePending() }
  }

  /// Writes what's waiting now, after any write under way.
  public func flush() {
    queue.sync { writePending() }
  }

  private func writePending() {
    guard let value = pending.withLock({ pending in
      defer { pending = nil }
      return pending
    }) else { return }
    file.write(value)
  }
}
