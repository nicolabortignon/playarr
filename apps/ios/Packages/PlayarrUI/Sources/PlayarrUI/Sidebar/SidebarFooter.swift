import Foundation
import PlayarrAPI

/// The foot of the sidebar (apps/web/src/components/Nav.tsx 191-235): the library's counts, then whether Lidarr
/// and streaming answer. The MusicBrainz queue (phase 8's `MusicBrainzIndicator`) and the version follow it.
public struct SidebarFooter: Equatable, Sendable {
  public struct Stat: Equatable, Sendable {
    public let label: String
    public let value: String
  }

  public struct Status: Equatable, Sendable {
    public enum State: Equatable, Sendable { case unknown, ok, down }
    public let label: String
    public let state: State
    /// The version or source when it answers, the error when it doesn't.
    public let detail: String?
    /// "offline" beside the name: it's down and the server said so (not just unreachable).
    public let saysOffline: Bool
  }

  public let stats: [Stat]
  public let statuses: [Status]

  /// `failed`: asking the server for its health failed.
  public init(health: HealthStatus?, failed: Bool) {
    if let library = health?.library {
      stats = [
        Stat(label: "Tracks", value: String(library.tracks)),
        Stat(label: "Albums", value: String(library.albums)),
        Stat(label: "Runtime", value: Format.duration(library.durationSeconds)),
        Stat(label: "Size", value: String(format: "%.1f GB", Double(library.sizeBytes) / 1e9)),
      ]
    } else {
      stats = []
    }
    func state(_ ok: Bool?) -> Status.State {
      if health == nil && !failed { return .unknown }
      return ok == true && !failed ? .ok : .down
    }
    var statuses: [Status] = []
    if let lidarr = health?.lidarr {
      let s = state(lidarr.ok)
      statuses.append(Status(label: "Lidarr", state: s, detail: lidarr.ok ? lidarr.version.map { "v\($0)" } : lidarr.error, saysOffline: s == .down))
    }
    let media = health?.media
    let s = state(media?.ok)
    statuses.append(Status(label: "Streaming", state: s, detail: media?.ok == true ? media?.source.rawValue : media?.error, saysOffline: s == .down && health != nil))
    self.statuses = statuses
  }

  /// "v1.0.0 · 812": the version and the build, as the web shows its version and commit.
  public static func version(_ version: AppVersion) -> String {
    "v\(version.marketing) · \(version.build)"
  }
}
