import Foundation

/// Where the snapshot is kept: `widget/snapshot.json` in the App Group's folder, shared by the app and its widgets, with
/// the covers it names in `widget/covers/`.
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
  var covers: URL { folder.appending(path: "covers", directoryHint: .isDirectory) }

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

  /// A cover a snapshot names.
  public func cover(_ name: String) -> URL { covers.appending(path: name) }

  public func hasCover(_ name: String) -> Bool { FileManager.default.fileExists(atPath: cover(name).path) }

  public func writeCover(_ data: Data, named name: String) throws {
    try FileManager.default.createDirectory(at: covers, withIntermediateDirectories: true)
    try data.write(to: cover(name), options: .atomic)
  }

  /// Deletes the covers the snapshot no longer names.
  public func pruneCovers(keeping snapshot: WidgetSnapshot) {
    let named = Set((snapshot.albums + snapshot.mixes).compactMap(\.cover) + [snapshot.nowPlaying?.cover].compactMap { $0 })
    let files = (try? FileManager.default.contentsOfDirectory(atPath: covers.path)) ?? []
    for file in files where !named.contains(file) {
      try? FileManager.default.removeItem(at: cover(file))
    }
  }
}
