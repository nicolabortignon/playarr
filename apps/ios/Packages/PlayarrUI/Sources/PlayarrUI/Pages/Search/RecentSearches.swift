import Foundation
import Observation

/// Search's recent searches (apps/web/src/lib/recentSearches.ts; docs/design.md, "Patterns"), kept on this device for
/// the signed-in account (`AccountSession.recentSearches`, in the account's folder), newest first: the last eight. A
/// search counts once one of its results is opened or played, Return is pressed, or its words sit still for a moment
/// (`settled`), never every keystroke on the way to it: never one letter, and words that only carry on from the newest
/// search take its place.
@MainActor @Observable
public final class RecentSearches {
  /// How many are kept; the empty search page shows them all.
  public static let limit = 8
  /// Words left alone this long count as searched for.
  public static let settled: Duration = .milliseconds(2500)

  /// Newest first.
  public private(set) var list: [String]

  @ObservationIgnored private let file: URL?

  /// `file`: where the account's are kept on this device; nil keeps them in memory only (the demo).
  public init(file: URL? = nil) {
    self.file = file
    list = Self.read(file)
  }

  /// Remembers a search: first in the list, once (the same words in other capitals or accents replace it).
  public func record(_ query: String) {
    save(Self.recorded(query, into: list))
  }

  public func forget(_ query: String) {
    save(list.filter { $0 != query })
  }

  public func clear() {
    save([])
  }

  /// Puts a list back as it was (Undo).
  public func restore(_ saved: [String]) {
    save(Array(saved.prefix(Self.limit)))
  }

  /// × on a search: off the list at once, with Undo (docs/design.md, "Taking things back").
  public func remove(_ query: String, toasts: ToastCenter) {
    let before = list
    forget(query)
    toasts.undo("Removed “\(query)” from recent searches") { [weak self] in self?.restore(before) }
  }

  /// Clear: all of them at once, with Undo.
  public func removeAll(toasts: ToastCenter) {
    let before = list
    clear()
    toasts.undo("Cleared recent searches") { [weak self] in self?.restore(before) }
  }

  /// Counts `query` once it has sat still for `settled`; the wait is called off (the task cancelled) when the words
  /// change before then.
  public func recordWhenSettled(_ query: String, clock: any Clock<Duration> = ContinuousClock()) async {
    do { try await clock.sleep(for: Self.settled) } catch { return }
    record(query)
  }

  /// The list with `query` first. A search that only carries on from the newest one ("radio", then "radiohead") takes
  /// its place: it was typed on the way.
  static func recorded(_ query: String, into list: [String]) -> [String] {
    let words = collapsed(query)
    let key = fold(words)
    guard key.count >= 2 else { return list }
    var rest = list.filter { fold($0) != key }
    if let newest = rest.first, key.hasPrefix(fold(newest)) { rest.removeFirst() }
    return Array(([words] + rest).prefix(limit))
  }

  /// The same search typed another way: case, accents and spacing aside.
  static func fold(_ text: String) -> String {
    collapsed(text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil))
  }

  /// Runs of spaces as one, none at the ends.
  private static func collapsed(_ text: String) -> String {
    text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }

  /// What the file holds: words, at most the limit (anything else is left out).
  private static func read(_ file: URL?) -> [String] {
    guard let file, let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode([String].self, from: data) else {
      return []
    }
    return Array(saved.filter { !collapsed($0).isEmpty }.prefix(limit))
  }

  private func save(_ new: [String]) {
    list = new
    guard let file else { return }
    do {
      try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try JSONEncoder().encode(new).write(to: file, options: .atomic)
    } catch {
      // Not kept for next time: the list on screen is still right.
    }
  }
}
