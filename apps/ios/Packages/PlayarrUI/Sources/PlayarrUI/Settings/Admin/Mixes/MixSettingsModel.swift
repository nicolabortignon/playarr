import Foundation
import Observation
import PlayarrAPI

/// Settings → Mixes. How mixes are made is the server's, for admins (PUT /api/settings/mixes); each account
/// sees its own listening history and clears it (DELETE /api/settings/mixes/history). A change shows at
/// once and is put back if the server refuses it.
@MainActor @Observable
public final class MixSettingsModel {
  public private(set) var info: MixSettingsInfo?
  public private(set) var loadError: String?
  public private(set) var clearing = false
  /// What the last change did, or why it failed.
  public private(set) var notice: String?
  public private(set) var failed = false

  public let isAdmin: Bool
  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let deviceTimeZone: String
  @ObservationIgnored private let mixesChanged: @MainActor () -> Void

  public static let historyIntro =
    "What the mixes learn from: each song heard for 30 seconds, or skipped, and at what time of day. It stays on this server."
  /// Clearing the listening history: every play goes for good (MixesPanel.tsx).
  static func clearQuestion(plays: Int) -> LossQuestion {
    LossQuestion(
      title: "Clear listening history?",
      message:
        "\(plays > 1 ? "All \(AdminText.plural(plays, "song")) played are" : "Every song played is") forgotten for good, and the mixes start learning again from scratch. Favorites and playlists stay.",
      verb: "Clear history")
  }
  public static let soundText =
    "Energy boost, Chill, Deep focus, Wind down and Vibes of the hour are better once Playarr has measured how songs sound (tempo, loudness, energy); until then they go by genre. Measure every song in Settings → Analysis."

  public init(
    api: any APISending, isAdmin: Bool, deviceTimeZone: String = TimeZone.current.identifier,
    mixesChanged: @escaping @MainActor () -> Void = {}
  ) {
    self.api = api
    self.isAdmin = isAdmin
    self.deviceTimeZone = deviceTimeZone
    self.mixesChanged = mixesChanged
  }

  public func load() async {
    do {
      info = try await api.send(API.Settings.mixes())
      loadError = nil
    } catch {
      loadError = failureText(error)
    }
  }

  /// Missing kinds count as on.
  public func isEnabled(_ kind: MixKind) -> Bool {
    guard let info, let setting = MixKinds.setting(kind) else { return true }
    return info.enabled[keyPath: setting] != false
  }

  public func setEnabled(_ kind: MixKind, _ on: Bool) async {
    guard let setting = MixKinds.setting(kind), let change = MixKinds.change(kind) else { return }
    var enabled = MixSettingsPatch.Enabled()
    enabled[keyPath: change] = on
    await save(MixSettingsPatch(enabled: enabled)) { $0.enabled[keyPath: setting] = on }
  }

  /// The household's clock, or "The server’s" until a device has set it.
  public var timeZoneText: String { info?.timeZone ?? "The server’s" }

  /// "Use this device’s (Europe/London)", when this device is somewhere else.
  public var useDeviceZoneLabel: String? {
    guard info?.timeZone != deviceTimeZone, !deviceTimeZone.isEmpty else { return nil }
    return "Use this device’s (\(deviceTimeZone))"
  }

  public func useDeviceTimeZone() async {
    let zone = deviceTimeZone
    await save(MixSettingsPatch(timeZone: zone)) { $0.timeZone = zone }
  }

  public func setLength(_ length: Int) async { await save(MixSettingsPatch(length: length)) { $0.length = length } }
  public func setAdventurous(_ value: Double) async { await save(MixSettingsPatch(adventurous: value)) { $0.adventurous = value } }
  public func setBlastDays(_ days: Int) async { await save(MixSettingsPatch(blastDays: days)) { $0.blastDays = days } }
  public func setGenreMixes(_ count: Int) async { await save(MixSettingsPatch(genreMixes: count)) { $0.genreMixes = count } }
  public func setDecadeMixes(_ count: Int) async { await save(MixSettingsPatch(decadeMixes: count)) { $0.decadeMixes = count } }
  public func setRecordHistory(_ on: Bool) async { await save(MixSettingsPatch(recordHistory: on)) { $0.recordHistory = on } }

  /// The Discovery Weekly choice nearest the saved value.
  public var adventure: Double {
    let value = info?.adventurous ?? 0.5
    return MixKinds.adventure.min { abs($0.value - value) < abs($1.value - value) }?.value ?? 0.5
  }

  /// "1,234 songs played since 3 November 2026", or "Nothing played yet".
  public var historyText: String {
    guard let history = info?.history, history.plays > 0 else { return "Nothing played yet" }
    let since = history.since.flatMap(AdminText.date).map { " since \($0.formatted(.dateTime.day().month(.wide).year()))" } ?? ""
    return "\(AdminText.plural(history.plays, "song")) played\(since)"
  }

  public var canClear: Bool { (info?.history.plays ?? 0) > 0 && !clearing }

  /// After the question: every song this account played is forgotten.
  public func clearHistory() async {
    clearing = true
    defer { clearing = false }
    do {
      info = try await api.send(API.Settings.clearHistory())
      notice = "Listening history cleared"
      failed = false
      mixesChanged()
    } catch {
      notice = "Couldn’t clear the history: \(failureText(error))"
      failed = true
    }
  }

  private func save(_ patch: MixSettingsPatch, _ apply: (inout MixSettingsInfo) -> Void) async {
    guard var shown = info else { return }
    let previous = shown
    apply(&shown)
    info = shown
    do {
      info = try await api.send(API.Settings.saveMixes(patch))
      notice = nil
      mixesChanged()
    } catch {
      info = previous
      notice = "Couldn’t save: \(failureText(error))"
      failed = true
    }
  }
}
