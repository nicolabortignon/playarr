import PlayarrAPI
import Testing
@testable import PlayarrUI

/// A source's ⋯ menu, as the web's (SourcesPanel.tsx `SourceRow`): its actions in words, each with its glyph from
/// docs/design.md's icon map, Remove last after a line.
@MainActor @Suite struct SourceMenuTests {
  private func titles(_ groups: [[MenuAction]]) -> [[String]] { groups.map { $0.map(\.title) } }

  @Test func aFolderOffersEverythingInTheWebsOrder() {
    let groups = SourceMenu.groups(Samples.folder(), at: 1, of: 3, actions: .init())
    #expect(titles(groups) == [["Sync now", "Match again", "Organize files", "Edit"], ["Move up", "Move down"], ["Remove"]])
    #expect(
      groups.map { $0.map(\.systemImage) }
        == [["arrow.triangle.2.circlepath", "text.magnifyingglass", "folder.badge.gearshape", "pencil"], ["arrow.up", "arrow.down"], ["trash"]])
    // Only Remove is drawn as taking something away.
    #expect(groups.flatMap(\.self).filter(\.destructive).map(\.title) == ["Remove"])
  }

  @Test func lidarrHasNothingToMatchOrOrganize() {
    let groups = SourceMenu.groups(Samples.lidarr(), at: 0, of: 2, actions: .init())
    #expect(titles(groups) == [["Sync now", "Edit"], ["Move down"], ["Remove"]])
  }

  @Test func leavesOutWhatsAlreadyHappeningAndWhereThereIsNowhereToGo() {
    // Syncing: the line under it says so. Matching again: it's on its way. Alone: nowhere to move.
    let groups = SourceMenu.groups(Samples.folder(syncing: true), at: 0, of: 1, rematching: true, actions: .init())
    #expect(titles(groups) == [["Organize files", "Edit"], [], ["Remove"]])
  }

  @Test func eachItemDoesWhatItSays() {
    var done: [String] = []
    let actions = SourceMenu.Actions(
      syncNow: { done.append("sync") }, matchAgain: { done.append("match") }, organize: { done.append("organize") },
      edit: { done.append("edit") }, move: { done.append("move \($0)") }, remove: { done.append("remove") })
    for item in SourceMenu.groups(Samples.folder(), at: 1, of: 3, actions: actions).flatMap(\.self) { item.perform() }
    #expect(done == ["sync", "match", "organize", "edit", "move -1", "move 1", "remove"])
  }
}
