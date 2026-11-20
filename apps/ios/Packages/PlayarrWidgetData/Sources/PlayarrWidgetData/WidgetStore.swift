import Foundation

/// Where the snapshot is kept: `widget/snapshot.json` in the App Group's folder, shared by the app and its widgets.
public struct WidgetStore: Sendable {
  public static let appGroup = "group.me.tracklistme.playarr"

  public let folder: URL

  public init(folder: URL) {
    self.folder = folder
  }

  /// The App Group's store; nil when the group isn't there (a build signed without it).
  public static func live() -> WidgetStore? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
      .map { WidgetStore(folder: $0.appending(path: "widget", directoryHint: .isDirectory)) }
  }

  var file: URL { folder.appending(path: "snapshot.json") }

  /// The snapshot written last; nil when there's none or it can't be read (the widgets then say to open Playarr).
  public func read() -> WidgetSnapshot? {
    guard let data = try? Data(contentsOf: file) else { return nil }
    return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
  }

  /// Replaces the snapshot in one go, so a widget never reads half of it.
  public func write(_ snapshot: WidgetSnapshot) throws {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try JSONEncoder().encode(snapshot).write(to: file, options: .atomic)
  }
}
