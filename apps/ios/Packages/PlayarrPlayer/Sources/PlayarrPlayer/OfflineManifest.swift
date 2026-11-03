import Foundation

/// What one server and account keeps on this device, saved as `offline.json` in its folder (the web's persisted
/// `useOffline` state, without the limit: that's a device setting, `PlaybackSettings.offlineLimit`).
public struct OfflineManifest: Codable, Sendable, Equatable {
  /// Songs' whole files in `stream/`, by file id: kept as you listen (within the limit) or for downloads.
  public var songs: [Int: KeptFile] = [:]
  /// Transition files in `offline/transitions/`, by name: only ever kept for downloads.
  public var transitionFiles: [String: KeptFile] = [:]
  /// Downloads, by key.
  public var pins: [String: PinnedDownload] = [:]

  public init(songs: [Int: KeptFile] = [:], transitionFiles: [String: KeptFile] = [:], pins: [String: PinnedDownload] = [:]) {
    self.songs = songs
    self.transitionFiles = transitionFiles
    self.pins = pins
  }
}
