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

  /// Settings → Accounts and Sources on the demo server.
  static var settingsRoutes: [(method: HTTPMethod, path: String, answer: any Encodable & Sendable)] {
    let me = ListedAccount(
      id: account.id, username: account.username, name: account.name, role: account.role, canRequest: account.canRequest,
      sources: account.sources, hasPassword: true, plays: 312, playlists: 1)
    return [
      (.get, "/api/auth/me", account),
      (.get, "/api/accounts", [me, invited]),
      (.get, "/api/accounts/\(account.id)/sessions", [SessionInfo(id: 1, device: "iPhone", platform: "ios", createdAt: when, lastSeenAt: when, current: true)]),
      (.get, "/api/settings/sources", sources),
      (.get, "/api/settings/matching", MatchingSettings(acoustid: true, fingerprints: true)),
      (.get, "/api/musicbrainz/status", MusicBrainzStatus(queued: 0, background: 0, etaSeconds: 0, matching: 0)),
    ]
  }
}
