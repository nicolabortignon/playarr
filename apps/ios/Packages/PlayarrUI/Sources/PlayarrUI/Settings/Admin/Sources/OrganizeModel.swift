import Foundation
import Observation
import PlayarrAPI

/// Settings → Sources → Organize files: the moves Playarr proposes into Artist/Album/NN Title, which to
/// apply (the sure ones start ticked), and undo of the last batch (OrganizeDialog).
@MainActor @Observable
public final class OrganizeModel {
  public private(set) var plan: OrganizePlan?
  public private(set) var loadError: String?
  /// The moves ticked, by their `from` path.
  public private(set) var chosen: Set<String> = []
  public private(set) var working = false
  /// What the last apply or undo did, or why it failed.
  public private(set) var notice: String?
  public private(set) var failed = false

  @ObservationIgnored private let sourceId: Int
  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let libraryChanged: @MainActor () -> Void

  public static let intro =
    "Files move into Artist/Album/NN Title, inside this folder only. Nothing is overwritten, tags aren’t changed, and you can undo. Moves Playarr is less sure about start unchecked."
  public static let notWritable =
    "Playarr can’t write to this folder, so it can’t move files. In Docker, mount the folder you want organized read-write (the broad /host mount stays read-only)."

  public init(sourceId: Int, api: any APISending, libraryChanged: @escaping @MainActor () -> Void = {}) {
    self.sourceId = sourceId
    self.api = api
    self.libraryChanged = libraryChanged
  }

  public func load() async {
    do {
      let plan = try await api.send(API.Settings.organizePlan(sourceId: sourceId))
      self.plan = plan
      chosen = Set(plan.moves.filter(\.confident).map(\.from))
      loadError = nil
    } catch {
      loadError = failureText(error)
    }
  }

  /// The moves by album, in the plan's order: "Massive Attack · Mezzanine".
  public var albums: [(title: String, moves: [OrganizeMove])] {
    var order: [String] = []
    var byTitle: [String: [OrganizeMove]] = [:]
    for move in plan?.moves ?? [] {
      let title = "\(move.artist) · \(move.album ?? "No album")"
      if byTitle[title] == nil { order.append(title) }
      byTitle[title, default: []].append(move)
    }
    return order.map { (title: $0, moves: byTitle[$0] ?? []) }
  }

  public func toggle(_ move: OrganizeMove) {
    if chosen.contains(move.from) { chosen.remove(move.from) } else { chosen.insert(move.from) }
  }

  public func chooseAll() { chosen = Set(plan?.moves.map(\.from) ?? []) }
  public func chooseNone() { chosen = [] }

  /// "3 of 12 moves selected".
  public var selectionText: String {
    "\(chosen.count) of \(AdminText.plural(plan?.moves.count ?? 0, "move")) selected"
  }

  /// "Move 3 files", or "Moving…".
  public var applyLabel: String { working ? "Moving…" : "Move \(AdminText.plural(chosen.count, "file"))" }
  public var canApply: Bool { !chosen.isEmpty && !working }

  /// "Last change: 12 files moved <date>".
  public var lastBatchText: String? {
    guard let batch = plan?.lastBatch else { return nil }
    return "Last change: \(AdminText.plural(batch.files, "file")) moved \(AdminText.dateTime(batch.at))"
  }

  /// "3 files can’t move".
  public var skippedTitle: String? {
    guard let skipped = plan?.skipped, !skipped.isEmpty else { return nil }
    return "\(AdminText.plural(skipped.count, "file")) can’t move"
  }

  public func apply() async {
    guard canApply, let moves = plan?.moves else { return }
    await work {
      let result = try await api.send(API.Settings.organize(sourceId: sourceId, moves: moves.map(\.from).filter(chosen.contains)))
      return "Moved \(AdminText.plural(result.moved, "file"))\(result.skipped.isEmpty ? "" : "; \(result.skipped.count) skipped")"
    }
  }

  public func undo() async {
    guard let batch = plan?.lastBatch, !working else { return }
    await work {
      let result = try await api.send(API.Settings.undoOrganize(sourceId: sourceId, batchId: batch.id))
      return "Put \(AdminText.plural(result.restored, "file")) back"
    }
  }

  private func work(_ call: () async throws -> String) async {
    working = true
    defer { working = false }
    do {
      notice = try await call()
      failed = false
      libraryChanged()
      await load()
    } catch {
      notice = failureText(error)
      failed = true
    }
  }
}
