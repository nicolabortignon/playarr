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

extension Samples {
  static func candidate(_ id: String, title: String = "Mezzanine", score: Double = 0.92, detailed: Bool = true) -> ReviewCandidate {
    ReviewCandidate(
      releaseId: id, releaseGroupId: "rg-\(id)", title: title, artistName: "Massive Attack", year: 1998,
      date: detailed ? "1998-04-20" : nil, country: detailed ? "GB" : nil, status: "Official", format: detailed ? "CD" : nil,
      labels: detailed ? [.init(name: "Virgin", catalogNumber: "WBRCD4")] : nil, detailed: detailed, score: score,
      tracks: [.init(disc: 1, position: 1, title: "Angel", duration: 379), .init(disc: 1, position: 2, title: "Risingson", duration: 298)],
      matches: ["01 Angel.flac": 0])
  }

  static func group(_ key: String, album: String? = "Mezzanine", candidates: [ReviewCandidate]) -> ReviewGroup {
    ReviewGroup(
      groupKey: key, artistName: "Massive Attack", albumTitle: album,
      files: [
        .init(rel: "01 Angel.flac", title: "Angel", trackNumber: 1, discNumber: 1, duration: 380),
        .init(rel: "02 Risingson.flac", title: "Risingson", trackNumber: 2, discNumber: 1, duration: 299),
      ],
      candidates: candidates)
  }
}
