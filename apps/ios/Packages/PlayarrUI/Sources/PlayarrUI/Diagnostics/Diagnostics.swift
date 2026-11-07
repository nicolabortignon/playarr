import Foundation
import OSLog
import PlayarrAPI
import PlayarrPlayer

#if canImport(UIKit)
  import UIKit
#endif

/// Settings → Copy diagnostics (plan 3 §6): what someone helping with a problem needs, as text the listener copies and
/// sends themselves. The app and the device, the server's version (asked again, which tells whether it answers) and the
/// account's role, the addresses in use, the network, the player and downloads, MetricKit's hang and crash reports
/// (`HangReports`), and the app's recent log (`Log`). No addresses, tokens, names or titles: songs are their ids.
struct Diagnostics: Equatable {
  var app: String
  var system: String
  var server: String
  var account: String
  var addresses: String
  var network: String
  var player: String
  var problem: String?
  var downloads: String
  var reports: [String]
  var log: [String]

  var text: String {
    var lines = [
      app, system, "Server: \(server)", "Account: \(account)", "Addresses: \(addresses)", "Network: \(network)", "Player: \(player)",
    ]
    if let problem { lines.append("Problem: \(problem)") }
    lines.append("Downloads: \(downloads)")
    lines.append("")
    lines.append(reports.isEmpty ? "No hang or crash reports from MetricKit." : "Hang and crash reports (MetricKit):")
    lines += reports
    lines.append("")
    lines.append(log.isEmpty ? "No recent log." : "Recent log:")
    lines += log
    return lines.joined(separator: "\n")
  }

  /// Gathers it all for `session`; the log is read off the main thread (`log`: tests read none).
  @MainActor static func gather(
    app model: AppModel, session: AccountSession, reports: [String] = HangReports.shared.reports,
    log readLog: @escaping @Sendable () -> [String] = { recentLog() }
  ) async -> Diagnostics {
    let server: String
    do {
      let info = try await session.api.send(API.Server.info())
      server = "Playarr \(info.version), for apps from \(info.minAppVersion)"
    } catch {
      server = "didn’t answer: \(error.localizedDescription)"
    }
    let player = session.player
    let log = await Task.detached { readLog() }.value
    return Diagnostics(
      app: "Playarr \(model.appVersion)",
      system: system(),
      server: server,
      account: "\(session.account.role.rawValue)\(session.account.canRequest ? ", can request" : "")",
      addresses: addresses(model.store),
      network: String(describing: player.network()),
      player: describe(player),
      problem: player.error,
      downloads: describe(player.downloads, limit: player.settings.offlineLimit),
      reports: reports,
      log: log)
  }

  /// "public (https); home address known, proven on this network".
  @MainActor static func addresses(_ store: ServerStore) -> String {
    guard let server = store.activeServer else { return "none" }
    let home = server.localURL == nil ? "no home address" : store.activeClient?.home?.isProven == true ? "home address proven on this network" : "home address known, not proven on this network"
    return "public (\(server.baseURL.scheme ?? "?")); \(home)"
  }

  /// "playing song 3 of 12 (id 5021) at 1:23 of 4:56; DJ mix; even volume".
  @MainActor static func describe(_ player: Player) -> String {
    let queue = player.queue
    guard let track = queue.currentTrack else { return "nothing queued" }
    let state = player.isStalled ? "waiting out a dead spot" : queue.playing ? "playing" : "paused"
    let settings = player.settings
    let mixing = switch settings.transitions {
    case .dj: "DJ mix"
    case .crossfade: "crossfade \(Int(settings.crossfade)) s"
    default: "no fades"
    }
    return "\(state) song \(queue.pos + 1) of \(queue.order.count) (id \(track.id)) at \(clock(player.time)) of \(clock(player.duration)); \(mixing)"
      + (settings.levelVolume ? "; even volume" : "")
  }

  /// "3 downloads, 42 songs, 1.2 GB of 8 GB".
  @MainActor static func describe(_ downloads: DownloadStore, limit: Int64) -> String {
    let manifest = downloads.manifest
    let bytes = manifest.songs.values.reduce(0) { $0 + $1.bytes } + manifest.transitionFiles.values.reduce(0) { $0 + $1.bytes }
    let size = ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    let of = limit > 0 ? " of \(ByteCountFormatter.string(fromByteCount: limit, countStyle: .file))" : ""
    return "\(manifest.pins.count) downloads, \(manifest.songs.count) songs kept, \(size)\(of)"
  }

  static func clock(_ seconds: Double) -> String {
    let whole = Int(seconds.isFinite ? max(0, seconds) : 0)
    return String(format: "%d:%02d", whole / 60, whole % 60)
  }

  /// "iOS 26.1 · iPhone17,2" (the model's identifier; a simulator says which model it plays).
  @MainActor static func system() -> String {
    let os = ProcessInfo.processInfo.operatingSystemVersion
    #if canImport(UIKit)
      let name = UIDevice.current.systemName
    #else
      let name = "macOS"
    #endif
    let model = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"].map { "\($0) simulator" } ?? machine()
    return "\(name) \(os.majorVersion).\(os.minorVersion)\(os.patchVersion > 0 ? ".\(os.patchVersion)" : "") · \(model)"
  }

  static func machine() -> String {
    var info = utsname()
    uname(&info)
    return withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
  }

  /// The app's log lines of the last hour, the newest `limit`: "17:02:11.208 [player] Song 5021 from 0.0 s".
  nonisolated static func recentLog(limit: Int = 300) -> [String] {
    guard let store = try? OSLogStore(scope: .currentProcessIdentifier) else { return [] }
    let since = store.position(date: Date().addingTimeInterval(-3600))
    let mine = NSPredicate(format: "subsystem == %@", Log.subsystem)
    guard let entries = try? store.getEntries(at: since, matching: mine) else { return [] }
    let time = Date.FormatStyle().hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).second(.twoDigits).secondFraction(.fractional(3))
    let lines = entries.compactMap { $0 as? OSLogEntryLog }.map { "\($0.date.formatted(time)) [\($0.category)] \($0.composedMessage)" }
    return Array(lines.suffix(limit))
  }
}
