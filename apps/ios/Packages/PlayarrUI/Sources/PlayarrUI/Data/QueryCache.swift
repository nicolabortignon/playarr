import Foundation

/// Stale-while-revalidate for the server's answers, per server and account. Answers are kept in memory; the library
/// (`QueryKey.isKept`) is also kept on disk for 7 days, so the app opens with it on screen and browses offline, as the
/// web's persisted React Query cache does. Two asks for the same key at once make one request.
@MainActor
public final class QueryCache {
  /// How long kept answers stay on disk (the web's `KEEP_FOR`).
  public static let keepFor: TimeInterval = 7 * 24 * 60 * 60
  /// After this an answer is shown but asked again (the web's default `staleTime`).
  public static let defaultStaleAfter: TimeInterval = 5 * 60

  private struct Entry {
    var value: any Sendable
    var updatedAt: Date
  }

  private var memory: [QueryKey: Entry] = [:]
  private var inFlight: [QueryKey: Task<any Sendable, any Error>] = [:]
  private var writes: [Task<Void, Never>] = []
  private let disk: QueryDisk?
  private let now: () -> Date

  /// `directory` nil keeps nothing on disk.
  public init(directory: URL?, now: @escaping () -> Date = Date.init) {
    self.disk = directory.map(QueryDisk.init)
    self.now = now
  }

  /// The answer kept for `key` and when it came, from memory or else from disk; nil if none (or older than 7 days).
  public func cached<T: Codable & Sendable>(_ key: QueryKey, as type: T.Type = T.self) -> (value: T, updatedAt: Date)? {
    if let entry = memory[key], let value = entry.value as? T { return (value, entry.updatedAt) }
    guard key.isKept, let disk, let stored = disk.read(T.self, file: key.fileName) else { return nil }
    guard now().timeIntervalSince(stored.updatedAt) < Self.keepFor else {
      disk.remove(file: key.fileName)
      return nil
    }
    memory[key] = Entry(value: stored.value, updatedAt: stored.updatedAt)
    return (stored.value, stored.updatedAt)
  }

  /// No answer yet, or it's older than `after` seconds.
  public func isStale(_ key: QueryKey, after: TimeInterval) -> Bool {
    guard let updatedAt = memory[key]?.updatedAt else { return true }
    return now().timeIntervalSince(updatedAt) >= after
  }

  /// Asks the server (once, however many ask at the same time) and keeps the answer.
  public func fetch<T: Codable & Sendable>(_ key: QueryKey, _ load: @escaping @Sendable () async throws -> T) async throws -> T {
    if let running = inFlight[key] {
      guard let value = try await running.value as? T else { throw CancellationError() }
      return value
    }
    let task = Task<any Sendable, any Error> { try await load() }
    inFlight[key] = task
    defer { inFlight[key] = nil }
    guard let value = try await task.value as? T else { throw CancellationError() }
    set(value, for: key)
    return value
  }

  /// Fetches `key` in the background when there's no answer or it's stale: a page about to be opened.
  public func prefetch<T: Codable & Sendable>(_ key: QueryKey, staleAfter: TimeInterval = defaultStaleAfter, _ load: @escaping @Sendable () async throws -> T) {
    guard cached(key, as: T.self) == nil || isStale(key, after: staleAfter), inFlight[key] == nil else { return }
    Task { _ = try? await fetch(key, load) }
  }

  /// Keeps `value` as the answer for `key` now (in memory, and on disk when kept).
  public func set<T: Codable & Sendable>(_ value: T, for key: QueryKey) {
    let updatedAt = now()
    memory[key] = Entry(value: value, updatedAt: updatedAt)
    guard key.isKept, let disk else { return }
    let file = key.fileName
    writes.append(Task.detached { await disk.write(value, updatedAt: updatedAt, file: file) })
  }

  /// Every answer named `name` is asked again the next time it's shown.
  public func invalidate(_ name: String) {
    for key in memory.keys where key.name == name { memory[key]?.updatedAt = .distantPast }
  }

  /// Waits for answers being written to disk (tests, and before the app is closed).
  public func flush() async {
    let pending = writes
    writes = []
    for write in pending { await write.value }
  }

  /// Deletes answers kept on disk for more than 7 days.
  public func removeExpired() async {
    await disk?.removeOlder(than: now().addingTimeInterval(-Self.keepFor))
  }
}

/// The disk side of `QueryCache`: one JSON file per kept key, `{ updatedAt, value }`.
actor QueryDisk {
  private struct Stored<T: Codable>: Codable {
    var updatedAt: Date
    var value: T
  }

  nonisolated let directory: URL

  init(directory: URL) {
    self.directory = directory
  }

  nonisolated func read<T: Codable>(_ type: T.Type, file: String) -> (value: T, updatedAt: Date)? {
    guard let data = try? Data(contentsOf: directory.appending(path: file)),
      let stored = try? JSONDecoder().decode(Stored<T>.self, from: data)
    else { return nil }
    return (stored.value, stored.updatedAt)
  }

  nonisolated func remove(file: String) {
    try? FileManager.default.removeItem(at: directory.appending(path: file))
  }

  func write<T: Codable & Sendable>(_ value: T, updatedAt: Date, file: String) {
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try JSONEncoder().encode(Stored(updatedAt: updatedAt, value: value)).write(to: directory.appending(path: file), options: .atomic)
    } catch {
      // A full disk loses the copy, not the answer: it's still in memory.
    }
  }

  func removeOlder(than date: Date) {
    let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
    for file in files {
      let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
      if modified < date { try? FileManager.default.removeItem(at: file) }
    }
  }
}
