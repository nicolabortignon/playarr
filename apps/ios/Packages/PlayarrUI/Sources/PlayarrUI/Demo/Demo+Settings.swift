import Foundation
import PlayarrAPI

extension Demo {
  /// Someone invited to the demo server who never set up: Settings → Accounts says so, with Copy invite link and New
  /// code.
  static let invited = ListedAccount(
    id: 3, username: "jo", name: "Jo", role: .member, canRequest: true, sources: nil, hasPassword: false, plays: 0, playlists: 0)

  /// The demo's music on the server's disk, and Lidarr: what Settings → Sources lists.
  static let sources = SourcesResponse(
    sources: [
      SourceInfo(
        id: 1, kind: .folder, name: "Music", position: 0, enabled: true, settings: .init(path: "/music"), secrets: [],
        lastSyncAt: when, syncing: false, songs: 8, albums: 3, albumsComplete: 2, albumsIncomplete: 1, albumsUnknown: 0,
        songsComplete: 5, songsIncomplete: 3, songsUnknown: 0, matched: 8, review: 0, ignored: 0, matching: 0, writable: true),
      SourceInfo(
        id: 2, kind: .lidarr, name: "Lidarr", position: 1, enabled: true, settings: .init(url: "http://192.168.1.10:8686"),
        secrets: ["apiKey"], lastSyncAt: when, syncing: false, songs: 0, albums: 0, albumsComplete: 0, albumsIncomplete: 0,
        albumsUnknown: 0, songsComplete: 0, songsIncomplete: 0, songsUnknown: 0, matched: 0, review: 0, ignored: 0, matching: 0),
    ],
    canEdit: true)

  /// Settings' server panels on the demo server: Accounts, Sources, Made for you, Analysis, Requests and Updates.
  static var settingsRoutes: [(method: HTTPMethod, path: String, answer: any Encodable & Sendable)] {
    let me = ListedAccount(
      id: account.id, username: account.username, name: account.name, role: account.role, canRequest: account.canRequest,
      sources: account.sources, hasPassword: true, plays: 312, playlists: 1)
    let songs = tracks.count
    // The updater checked ten minutes ago and found the version running is the newest.
    let checked = Int(Date().timeIntervalSince1970) - 600
    let commit = "4f2c9e1b7a3d5f60c8e2a9b1d4f7c3e5a6b8d0f2"
    return [
      (.get, "/api/server", server),
      (.get, "/api/auth/me", account),
      (.get, "/api/accounts", [me, invited]),
      (.get, "/api/accounts/\(account.id)/sessions", [SessionInfo(id: 1, device: "iPhone", platform: "ios", createdAt: when, lastSeenAt: when, current: true)]),
      (.get, "/api/settings/sources", sources),
      (.get, "/api/settings/matching", MatchingSettings(acoustid: true, fingerprints: true)),
      (.get, "/api/musicbrainz/status", MusicBrainzStatus(queued: 0, background: 0, etaSeconds: 0, matching: 0)),
      (
        .get, "/api/settings/mixes",
        MixSettingsInfo(
          enabled: .init(), length: 30, adventurous: 0.5, blastDays: 365, genreMixes: 3, decadeMixes: 3, recordHistory: true,
          analyzeLibrary: true, timeZone: TimeZone.current.identifier, analysisAvailable: true,
          history: .init(plays: me.plays, since: "2026-09-01T09:00:00.000Z"))
      ),
      (.get, "/api/settings/listenbrainz", ListenBrainzInfo(connected: false, enabled: false, pending: 0, sent: 0, earlier: me.plays)),
      (
        .get, "/api/analysis/progress",
        AnalysisProgress(
          enabled: true, songs: songs, beats: .init(ready: songs, beatModel: songs, failed: 0), sound: .init(ready: songs, failed: 0),
          loudness: .init(ready: songs, failed: 0), tags: .init(ready: songs, songs: songs), waiting: 0, working: 0, loudnessWaiting: 0,
          loudnessWorking: 0, tagsWaiting: 0, libraryScan: true)
      ),
      (
        .get, "/api/settings/requests",
        RequestSettingsInfo(
          enabled: true, searchOnAdd: true, rootFolderPath: "/music", qualityProfileId: 1, metadataProfileId: 1, lidarr: true,
          options: .init(
            rootFolders: [.init(path: "/music", freeSpace: 1_200_000_000_000)],
            qualityProfiles: [.init(id: 1, name: "Lossless"), .init(id: 2, name: "Any")],
            metadataProfiles: [.init(id: 1, name: "Standard")]))
      ),
      (
        .get, "/api/settings/updates",
        UpdateInfo(
          enabled: true, intervalMinutes: 60, available: true,
          status: .init(state: .idle, lastCheck: checked, lastUpdate: checked - 3 * 86_400, deployed: commit, latest: commit),
          requested: false)
      ),
    ]
  }

  /// What a change the demo server doesn't make answers (a setting saved, an account added, Check now): the demo's
  /// server stays as it is, which beats a "Not found".
  static let unchanged = APIError.server(status: 403, message: "In the demo, the server’s settings stay as they are.")

  /// The server's settings, accounts and analysis: what `unchanged` answers changes to.
  static func isServerSetting(_ path: String) -> Bool {
    ["/api/settings/", "/api/accounts", "/api/analysis/"].contains { path.hasPrefix($0) }
  }
}
