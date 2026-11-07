import Foundation
import Observation
import PlayarrAPI

/// Settings → Updates (Docker installs with the updater running): the channel (GitHub releases or main), updating
/// automatically or not, how often to check, Check now, and the last run's log. Polled every 5 s while a check is
/// waiting or running, every minute otherwise.
@MainActor @Observable
public final class UpdatesModel {
  public static let intervals: [(minutes: Int, label: String)] = [(15, "15 minutes"), (60, "Hour"), (360, "6 hours"), (1440, "Day")]
  public static let channels: [(channel: UpdateChannel, label: String)] = [(.stable, "Stable"), (.edge, "Edge")]
  public static let intro =
    "Playarr downloads the newest version on its channel from GitHub, rebuilds itself and restarts; the music keeps playing from your device’s cache. A version is installed only once its checks pass on GitHub, and if it doesn’t start, the version that was running comes back."
  public static let startCommand = "sudo sh update.sh"

  /// What a channel installs, under the choice.
  public static func note(for channel: UpdateChannel) -> String {
    switch channel {
    case .stable: "Releases only: the versions published on GitHub as ready for everyone. Switching from Edge installs the newest release at the next check, even an older one."
    case .edge: "Every change to the main branch, once its checks pass on GitHub: the newest, and sometimes rough."
    case .unknown: ""
    }
  }

  public private(set) var info: UpdateInfo?
  public private(set) var loadError: String?
  /// The server's version (GET /api/server).
  public private(set) var serverVersion: String?
  public private(set) var checking = false
  public private(set) var notice: String?

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let clock: any Clock<Duration>

  public init(api: any APISending, clock: any Clock<Duration> = ContinuousClock()) {
    self.api = api
    self.clock = clock
  }

  /// A Check now is waiting for the updater, or the updater is checking.
  public var busy: Bool { info?.requested == true || info?.status?.state.rawValue == "checking" }

  var pollInterval: Duration { busy ? .seconds(5) : .seconds(60) }

  public func poll() async {
    await Polling.run(clock: clock, interval: { [weak self] in self?.pollInterval }) { [weak self] in await self?.load() }
  }

  public func load() async {
    do {
      info = try await api.send(API.Settings.updates())
      loadError = nil
    } catch {
      loadError = failureText(error)
    }
    if serverVersion == nil { serverVersion = try? await api.send(API.Server.info()).version }
  }

  public func setEnabled(_ on: Bool) async { await save(UpdateSettingsPatch(enabled: on)) { $0.enabled = on } }
  public func setInterval(_ minutes: Int) async { await save(UpdateSettingsPatch(intervalMinutes: minutes)) { $0.intervalMinutes = minutes } }
  public func setChannel(_ channel: UpdateChannel) async { await save(UpdateSettingsPatch(channel: channel)) { $0.channel = channel } }

  /// The updater picks it up within half a minute.
  public func checkNow() async {
    checking = true
    defer { checking = false }
    do {
      info = try await api.send(API.Settings.checkForUpdates())
      notice = nil
    } catch {
      notice = "Couldn’t check for updates: \(failureText(error))"
    }
  }

  public var checkLabel: String { busy ? "Checking…" : "Check now" }

  /// "Playarr v0.7.3 · 1a2b3c4".
  public var versionText: String {
    let deployed = info?.status?.deployed.map { " · \(short($0))" } ?? ""
    return "Playarr v\(serverVersion ?? "?")\(deployed)"
  }

  /// "Latest on main: 9f8e7d6 · A newer version is available", "Latest release: v0.7.0 · 9f8e7d6 · Up to date".
  public var latestText: String? {
    guard let status = info?.status else { return nil }
    guard let latest = status.latest else { return status.outcome == .noRelease ? "Latest release: none yet" : nil }
    var text = status.channel == .stable
      ? "Latest release: \(status.release.map { "\($0) · " } ?? "")\(short(latest))"
      : "Latest on main: \(short(latest))"
    if let running = status.deployed {
      let upToDate = latest.hasPrefix(running) || running.hasPrefix(latest)
      text += " · " + (upToDate ? "Up to date" : Self.notInstalled(status.outcome) ?? "A newer version is available")
    }
    return text
  }

  /// Why the newest version isn't the one running, when the last check said.
  private static func notInstalled(_ outcome: UpdateInfo.Status.Outcome?) -> String? {
    switch outcome {
    case .waiting?: "Waiting for its checks"
    case .checksFailed?: "Its checks failed"
    case .rolledBack?: "It didn’t start"
    default: nil
    }
  }

  /// Why updates can't be managed here, and the command that starts the updater when that's the reason.
  public var unavailable: (text: String, command: String?)? {
    guard let info, !info.available else { return nil }
    if info.reason?.contains("update.sh") == true {
      return ("The updater isn’t running yet. To start it, run this once in Playarr’s folder on the server:", Self.startCommand)
    }
    return ("\(info.reason ?? "Automatic updates aren’t available here").", nil)
  }

  /// "2 minutes ago · Already up to date", and whether it's a failure. A failure's words are update.sh's own (failed
  /// checks and a version that didn't start among them).
  public func lastCheck(now: Date = Date()) -> (text: String, failed: Bool) {
    let status = info?.status
    if status?.state.rawValue == "checking" || (info?.requested == true && (status?.lastCheck ?? 0) == 0) {
      return ("Checking for a new version…", false)
    }
    guard let status, status.lastCheck > 0 else { return ("Not checked yet.", false) }
    let when = AdminText.ago(status.lastCheck, now: now)
    if status.state.rawValue == "failed" { return ("\(when) · \(status.error ?? "The update failed")", true) }
    if status.outcome == .waiting, status.latest != nil { return ("\(when) · \(latestName(status)) is waiting for its checks on GitHub", false) }
    if status.outcome == .noRelease { return ("\(when) · No release yet: Playarr stays on this version until the first one", false) }
    if status.lastUpdate == status.lastCheck, let deployed = status.deployed {
      return ("\(when) · Updated to \(deployed == status.latest ? latestName(status) : short(deployed))", false)
    }
    return ("\(when) · Already up to date", false)
  }

  private func short(_ sha: String) -> String { String(sha.prefix(7)) }

  /// The newest version on the channel by its name: the release on stable, else the commit.
  private func latestName(_ status: UpdateInfo.Status) -> String {
    if status.channel == .stable, let release = status.release { return release }
    return short(status.latest ?? "")
  }

  private func save(_ patch: UpdateSettingsPatch, _ apply: (inout UpdateInfo) -> Void) async {
    guard var shown = info else { return }
    let previous = shown
    apply(&shown)
    info = shown
    do {
      info = try await api.send(API.Settings.saveUpdates(patch))
      notice = nil
    } catch {
      info = previous
      notice = "Couldn’t save: \(failureText(error))"
    }
  }
}
