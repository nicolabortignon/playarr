import PlayarrAPI

/// Server answers for the admin panels' tests.
enum Samples {
  static func lidarr(id: Int = 1, syncing: Bool = false) -> SourceInfo {
    SourceInfo(
      id: id, kind: .lidarr, name: "Lidarr", position: 0, enabled: true,
      settings: .init(url: "http://192.168.1.10:8686"), secrets: ["apiKey"], lastSyncAt: "2026-11-03T10:00:00Z",
      syncing: syncing, songs: 1200, albums: 100, review: 0, matching: 0)
  }

  static func folder(
    id: Int = 2, name: String = "Music", access: FolderAccessKind? = nil, syncing: Bool = false, matching: Int = 0,
    review: Int = 0, secrets: [String] = []
  ) -> SourceInfo {
    let remote = access != nil && access != .local
    return SourceInfo(
      id: id, kind: .folder, name: name, position: 1, enabled: true,
      settings: .init(
        path: access == .smb ? "/music/Albums" : "/music", access: access, host: remote ? "nas" : nil,
        port: access == .smb ? 445 : (remote ? 22 : nil), user: remote ? "guest" : nil),
      secrets: secrets, syncing: syncing, songs: 1, albums: 1, review: review, matching: matching, writable: true)
  }

  static func sources(_ list: [SourceInfo], canEdit: Bool = true) -> SourcesResponse {
    SourcesResponse(sources: list, canEdit: canEdit)
  }
}
