import Foundation
import PlayarrAPI

/// Where one server and account keeps audio on this device: `Application Support/Playarr/<serverId>/<accountId>/`,
/// with songs' files in `stream/` (phase 3's stream cache: `<fileId>.<ext>`, `.part` while incomplete), transitions
/// of downloads in `offline/transitions/`, interrupted downloads' resume data in `offline/resume/`, and the manifest
/// in `offline.json`. None of it goes to iCloud backups: it can all be downloaded again.
public struct OfflineFolder: Sendable, Equatable {
  /// `Application Support/Playarr/`: every server and account's folder is inside, and background downloads are named
  /// by their path from here.
  public let base: URL
  /// `<serverId>/<accountId>`.
  public let account: String

  public init(base: URL, account: String) {
    self.base = base
    self.account = account
  }

  /// The folder of an account folder's path (its last two components are the server and account).
  public init(root: URL) {
    let server = root.deletingLastPathComponent()
    self.init(base: server.deletingLastPathComponent(), account: "\(server.lastPathComponent)/\(root.lastPathComponent)")
  }

  public static let applicationBase = URL.applicationSupportDirectory.appending(path: "Playarr", directoryHint: .isDirectory)

  /// The one place the per-account folder is worked out.
  public static func of(_ key: AccountKey, base: URL = applicationBase) -> OfflineFolder {
    OfflineFolder(base: base, account: "\(key.serverId)/\(key.accountId)")
  }

  public var root: URL { base.appending(path: account, directoryHint: .isDirectory) }
  public var stream: URL { root.appending(path: "stream", directoryHint: .isDirectory) }
  public var transitions: URL { root.appending(path: "offline/transitions", directoryHint: .isDirectory) }
  public var resume: URL { root.appending(path: "offline/resume", directoryHint: .isDirectory) }
  public var manifest: URL { root.appending(path: "offline.json") }

  /// A song's file, as the stream cache names it.
  /// A song's file in `stream/`: its own file (`12.flac`), or its encoded stream at a quality (`12.normal.m4a`).
  public static func songFileName(_ track: Track, quality: StreamQuality = .original) -> String {
    quality == .original ? "\(track.fileId).\(track.format.container.lowercased())" : "\(track.fileId).\(quality.rawValue).m4a"
  }
  public func songPath(_ track: Track, quality: StreamQuality = .original) -> String { "stream/\(Self.songFileName(track, quality: quality))" }
  /// "12.normal.m4a" → 12.
  static func fileId(ofName name: String) -> Int? { Int(name.prefix { $0 != "." }) }
  /// The quality of a song's file, by its name or path: an encoded stream's says it, a song's own file doesn't.
  public static func quality(ofSongPath path: String) -> StreamQuality {
    let parts = (path as NSString).lastPathComponent.split(separator: ".")
    return parts.count == 3 && parts[2] == "m4a" ? StreamQuality(rawValue: String(parts[1])) ?? .original : .original
  }
  public func transitionPath(_ name: String) -> String { "offline/transitions/\(name)" }
  public func url(_ path: String) -> URL { root.appending(path: path) }

  /// A background download's name: its file's path from `base`, so it lands in the right folder even when another
  /// account is active by then, or the app was relaunched.
  public func jobID(_ path: String) -> String { "\(account)/\(path)" }
  /// The path in this folder a job is for; nil for another account's.
  public func path(ofJob id: String) -> String? {
    id.hasPrefix(account + "/") ? String(id.dropFirst(account.count + 1)) : nil
  }

  /// Makes the folders, kept out of backups (a folder excluded is excluded with everything in it).
  public func prepare() {
    for url in [stream, transitions, resume] {
      try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }
    Self.excludeFromBackup(stream)
    Self.excludeFromBackup(root.appending(path: "offline", directoryHint: .isDirectory))
  }

  public static func excludeFromBackup(_ url: URL) {
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var url = url
    try? url.setResourceValues(values)
  }

  public struct FoundFile: Sendable, Equatable {
    public var path: String
    public var bytes: Int64
    public var modified: Date
  }

  /// Songs' whole files in `stream/`, by file id (not `.part` files or a seek's levelled stream). A song kept at two
  /// qualities (the app closed between a better file arriving and the other going): the better, the other removed.
  public func songFiles() -> [Int: FoundFile] {
    var out: [Int: FoundFile] = [:]
    for (name, found) in files(in: stream, prefix: "stream/") {
      guard !name.hasSuffix(".part"), name.contains("."), let id = Self.fileId(ofName: name) else { continue }
      if let have = out[id] {
        let better = Self.quality(ofSongPath: found.path).atLeast(Self.quality(ofSongPath: have.path)) ? found : have
        remove(better == found ? have.path : found.path)
        out[id] = better
        continue
      }
      out[id] = found
    }
    return out
  }

  /// Transition files, by name.
  public func transitionFiles() -> [String: FoundFile] {
    var out: [String: FoundFile] = [:]
    for (name, found) in files(in: transitions, prefix: "offline/transitions/") where !name.hasSuffix(".part") { out[name] = found }
    return out
  }

  public func size(of path: String) -> Int64? {
    (try? url(path).resourceValues(forKeys: [.fileSizeKey]))?.fileSize.map(Int64.init)
  }

  public func remove(_ path: String) {
    try? FileManager.default.removeItem(at: url(path))
  }

  /// Everything this account keeps here: the folder goes.
  public func removeAll() {
    try? FileManager.default.removeItem(at: stream)
    try? FileManager.default.removeItem(at: root.appending(path: "offline", directoryHint: .isDirectory))
    try? FileManager.default.removeItem(at: manifest)
  }

  /// Room left on the device for what the user asked to keep (`volumeAvailableCapacityForImportantUsage`): space
  /// iOS would free for it is counted. Nil when the system won't say.
  public static func availableCapacity(at url: URL = .applicationSupportDirectory) -> Int64? {
    (try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage
  }

  private func files(in directory: URL, prefix: String) -> [(String, FoundFile)] {
    let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
    let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys)) ?? []
    return urls.compactMap { url in
      guard let v = try? url.resourceValues(forKeys: Set(keys)), v.isRegularFile == true else { return nil }
      let name = url.lastPathComponent
      return (name, FoundFile(path: prefix + name, bytes: Int64(v.fileSize ?? 0), modified: v.contentModificationDate ?? .distantPast))
    }
  }
}
