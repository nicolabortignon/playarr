import PlayarrAPI

/// A source's ⋯ menu (SourcesPanel.tsx `SourceRow`; docs/design.md, "Rows, menus and toasts"): what can be done with
/// it, in words, each with its glyph, the same from ⋯, a long press and VoiceOver: Sync now (not while it syncs), Match
/// again and Organize files (a folder's), Edit; then Move up and Move down where it has somewhere to go; then Remove,
/// which asks first.
enum SourceMenu {
  /// What each item does, for the source it's opened on.
  struct Actions {
    var syncNow: @MainActor () -> Void = {}
    var matchAgain: @MainActor () -> Void = {}
    var organize: @MainActor () -> Void = {}
    var edit: @MainActor () -> Void = {}
    /// One place up (-1) or down (1), as dragging it there would.
    var move: @MainActor (Int) -> Void = { _ in }
    var remove: @MainActor () -> Void = {}
  }

  /// The menu's groups, a line between each. `index` and `count` place the source in the list; `rematching`: its
  /// Match again is on its way.
  static func groups(_ source: SourceInfo, at index: Int, of count: Int, rematching: Bool = false, actions: Actions) -> [[MenuAction]] {
    var own: [MenuAction] = []
    // While it syncs, the line under it says so.
    if !source.syncing { own.append(MenuAction(.syncNow, perform: actions.syncNow)) }
    if source.kind == .folder {
      if !rematching { own.append(MenuAction(.matchAgain, perform: actions.matchAgain)) }
      // Offered even when the folder isn't writable: the sheet explains why nothing can move.
      own.append(MenuAction(.organizeFiles, perform: actions.organize))
    }
    own.append(MenuAction(.edit, perform: actions.edit))
    var moves: [MenuAction] = []
    if index > 0 { moves.append(MenuAction(.moveUp) { actions.move(-1) }) }
    if index < count - 1 { moves.append(MenuAction(.moveDown) { actions.move(1) }) }
    // Its songs leave the library, so it asks first: Delete's glyph, as an account's Remove.
    return [own, moves, [MenuAction(.remove, systemImage: "trash", perform: actions.remove)]]
  }
}
