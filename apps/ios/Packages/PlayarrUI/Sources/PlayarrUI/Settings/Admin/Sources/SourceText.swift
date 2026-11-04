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

  /// The remove question's title and message (the web's window.confirm text, split in two).
  static func removeTitle(_ source: SourceInfo) -> String { "Remove “\(source.name)”?" }
  static let removeMessage = "Its songs leave your library; favorites and playlists keep them, greyed out."
}
