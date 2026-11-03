import Foundation

/// A file kept on this device: where it is in the account's folder, its size, and when it was last played or
/// downloaded (the least recently used make room first), as `KeptSong` in apps/web/src/player/offline.ts.
public struct KeptFile: Codable, Sendable, Equatable {
  /// Relative to the account's folder: `stream/12.flac`, `offline/transitions/ab12….flac`.
  public var file: String
  public var bytes: Int64
  public var usedAt: Date

  public init(file: String, bytes: Int64, usedAt: Date) {
    self.file = file
    self.bytes = bytes
    self.usedAt = usedAt
  }
}
