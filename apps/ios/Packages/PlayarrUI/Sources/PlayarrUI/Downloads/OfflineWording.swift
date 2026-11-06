import Foundation
import PlayarrAPI
import PlayarrPlayer

/// The words of the web's download screens (DownloadButton.tsx, pages/Downloads.tsx, OfflineStorage.tsx), worked out
/// apart from the views so they're tested.
enum OfflineWording {
  /// "1 song", "12 songs" (`plural` in apps/web/src/lib/format.ts).
  static func count(_ n: Int, _ word: String) -> String { Format.plural(n, word) }

  // MARK: The Download button

  enum ButtonPhase: Equatable {
    case notDownloaded
    case downloading(done: Int, total: Int)
    case downloaded

    var fraction: Double {
      if case .downloading(let done, let total) = self, total > 0 { return Double(done) / Double(total) }
      return self == .downloaded ? 1 : 0
    }
  }

  static func phase(_ progress: DownloadProgress?) -> ButtonPhase {
    guard let progress else { return .notDownloaded }
    return progress.isComplete ? .downloaded : .downloading(done: progress.done, total: progress.total)
  }

  static func buttonLabel(_ phase: ButtonPhase, title: String) -> String {
    switch phase {
    case .notDownloaded: "Download \(title)"
    case .downloaded: "Downloaded: remove \(title) from this device"
    case .downloading(let done, let total): "Downloading, \(done) of \(total): remove \(title) from this device"
    }
  }

  static func started(_ title: String) -> String { "Downloading “\(title)”" }
  static func removed(_ title: String) -> String { "Removed “\(title)” from this device" }
  static func noRoomMessage(_ title: String, needed: Int64, free: Int64) -> String {
    "\(title) needs \(ByteCount.format(needed)), and \(ByteCount.format(free)) is free. Remove some downloads in Library → Downloads."
  }

  // MARK: Library → Downloads

  /// "Massive Attack · 3 of 11 songs · 132 MB", without the failures.
  static func rowDetail(_ d: PinnedDownload, _ progress: DownloadProgress) -> String {
    (d.subtitle.map { "\($0) · " } ?? "") + self.progress(progress)
  }

  /// "3 of 11 songs · 132 MB", or "11 songs · 484 MB" once they're all here: a row's numbers, after what it is.
  static func progress(_ progress: DownloadProgress) -> String {
    let songs = progress.isComplete ? count(progress.total, "song") : "\(progress.done) of \(count(progress.total, "song"))"
    return "\(songs) · \(ByteCount.format(progress.bytes))"
  }

  /// " · 2 couldn’t download", or nothing.
  static func failures(_ n: Int) -> String { n > 0 ? " · \(n) couldn’t download" : "" }

  // MARK: Settings → Playback → On this device

  static let explanation =
    "As you listen, the next songs in your queue are saved here, so they start instantly and keep playing without a connection. When space runs out, the songs you played longest ago make room."

  static func headline(count: Int, limit: Int64) -> String { limit > 0 ? self.count(count, "song") : "Off" }
  static func usage(bytes: Int64, limit: Int64) -> String? { limit > 0 ? "\(ByteCount.format(bytes)) of \(ByteCount.format(limit))" : nil }
  /// "Plus 3 downloads (4.2 GB), kept until you remove them." — the link is the first part.
  static func downloadsLine(count n: Int, bytes: Int64) -> (link: String, rest: String)? {
    n > 0 ? (count(n, "download"), " (\(ByteCount.format(bytes))), kept until you remove them.") : nil
  }

  /// Remove all: the question names how many songs go, the words what leaves this device and what doesn't
  /// (OfflineStorage.tsx). `downloads` and their bytes, then the songs saved as you listened and theirs.
  static func removeAllQuestion(songs: Int, downloads: Int, downloadBytes: Int64, saved: Int, savedBytes: Int64) -> LossQuestion {
    LossQuestion(
      title: "Remove \(count(songs, "song")) from this device?",
      message: whatGoes(downloads: downloads, downloadBytes: downloadBytes, saved: saved, savedBytes: savedBytes)
        + " Nothing leaves your library: anything can be downloaded again.",
      verb: "Remove all")
  }

  /// "2 downloads (1.2 GB) and 40 songs saved as you listened (310 MB) leave this device."
  static func whatGoes(downloads: Int, downloadBytes: Int64, saved: Int, savedBytes: Int64) -> String {
    let parts =
      (downloads > 0 ? ["\(count(downloads, "download")) (\(ByteCount.format(downloadBytes)))"] : [])
      + (saved > 0 ? ["\(count(saved, "song")) saved as you listened (\(ByteCount.format(savedBytes)))"] : [])
    let one = parts.count == 1 && (downloads > 0 ? downloads : saved) == 1
    return "\(parts.joined(separator: " and ")) \(one ? "leaves" : "leave") this device."
  }

  // MARK: Signing out

  static func signOutMessage(name: String, downloads: Int, bytes: Int64) -> String {
    downloads > 0
      ? "\(count(downloads, "download")) and other songs kept for \(name) take \(ByteCount.format(bytes)) on this device."
      : "Songs kept for \(name) take \(ByteCount.format(bytes)) on this device."
  }
}
