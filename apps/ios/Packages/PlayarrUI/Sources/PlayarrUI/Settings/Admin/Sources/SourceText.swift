import Foundation
import PlayarrAPI

/// How Settings → Sources describes a source (SourcesPanel.tsx: SourceRow and SourceStatus).
enum SourceText {
  enum Tone: Equatable { case accent, error, muted }

  /// A folder on another machine (SSH, SFTP or SMB).
  static func isRemote(_ source: SourceInfo) -> Bool {
    guard source.kind == .folder, let access = source.settings?.access else { return false }
    return access != .local
  }

  /// "smb://guest@nas/music/Albums · 120 songs · 10 albums".
  static func details(_ source: SourceInfo) -> String {
    let settings = source.settings
    let place: String?
    if isRemote(source), let settings {
      let user = settings.user ?? "", host = settings.host ?? "", path = settings.path ?? ""
      place = settings.access == .smb ? "smb://\(user)@\(host)\(path)" : "\(user)@\(host):\(path)"
    } else {
      place = settings?.url ?? settings?.path
    }
    let counts = "\(AdminText.plural(source.songs, "song")) · \(AdminText.plural(source.albums, "album"))"
    return [place, counts].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
  }

  /// How much of its albums a source has (AlbumSummary): Lidarr counts albums; a folder counts its songs, adding
  /// up to all of them, its songs not matched yet unidentified. Nil without albums. In lowercase: the web shows each
  /// as a chip of its own, here they run on in one line ("5 on complete albums · 0 unidentified").
  static func albumSummary(_ source: SourceInfo) -> [(count: Int, label: String)]? {
    guard source.albums > 0 else { return nil }
    let counters: [(Int, String, String)] =
      source.kind == .folder
      ? [
        (source.songsComplete, "on complete albums", "on complete albums"),
        (source.songsIncomplete, "on incomplete albums", "on incomplete albums"),
        (source.songsUnknown, "unidentified", "unidentified"),
      ]
      : [
        (source.albumsComplete, "complete album", "complete albums"),
        (source.albumsIncomplete, "incomplete album", "incomplete albums"),
        (source.albumsUnknown, "unidentified", "unidentified"),
      ]
    return counters.map { n, one, many in (n, n == 1 ? one : many) }
  }

  /// How a folder's songs were matched (MatchSummary): "12 songs matched", "3 not matched" (which opens the
  /// review) and "2 left as tagged". Nil for Lidarr, or a folder with nothing matched yet.
  static func matchSummary(_ source: SourceInfo) -> (matched: String, notMatched: String?, leftAsTagged: String?)? {
    guard source.kind == .folder, source.matched > 0 || source.review > 0 || source.ignored > 0 else { return nil }
    return (
      "\(AdminText.plural(source.matched, "song")) matched",
      source.review > 0 ? "\(source.review) not matched" : nil,
      source.ignored > 0 ? "\(source.ignored) left as tagged" : nil
    )
  }

  /// The status line under a source, and its colour.
  static func status(_ source: SourceInfo) -> (text: String, tone: Tone) {
    if source.syncing { return ("Syncing…", .accent) }
    if source.matching > 0 {
      // Each album takes a few MusicBrainz lookups at about one per second.
      let left = AdminText.plural(source.matching, "album")
      return ("Matching… \(left) left · about \(AdminText.wait(Double(source.matching) * 3.3))", .accent)
    }
    if let error = source.error { return (error, .error) }
    if !source.enabled { return ("Turned off", .muted) }
    if let synced = source.lastSyncAt { return ("Synced \(AdminText.dateTime(synced))", .muted) }
    return ("Not synced yet", .muted)
  }

  /// Removing a source: its songs leave the library, but nothing on disk is touched (SourcesPanel.tsx).
  static func removeQuestion(_ source: SourceInfo) -> LossQuestion {
    let leave = source.songs == 1 ? "Its song leaves" : "Its \(AdminText.plural(source.songs, "song")) leave"
    return LossQuestion(
      title: "Remove “\(source.name)”?",
      message:
        "\(leave) your library; playlists and Favorites keep them in their place, grayed out. The files themselves aren’t touched, and adding the source again brings them back.",
      verb: "Remove")
  }
}
