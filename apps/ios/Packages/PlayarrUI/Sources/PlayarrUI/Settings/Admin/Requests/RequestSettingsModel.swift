import Foundation
import Observation
import PlayarrAPI

/// Settings → Requests: whether people can request albums, whether Lidarr searches at once, and where new
/// artists go (root folder, quality and metadata profiles from Lidarr's lists; nothing chosen: Lidarr's default).
@MainActor @Observable
public final class RequestSettingsModel {
  /// One picker's choices: the default first, a saved choice Lidarr no longer has, then Lidarr's.
  public struct Choice<Value: Hashable>: Hashable {
    public let value: Value?
    public let label: String
  }

  public private(set) var info: RequestSettingsInfo?
  public private(set) var loadError: String?
  public private(set) var retrying = false
  public private(set) var notice: String?

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let requestsChanged: @MainActor () -> Void

  public static let defaultLabel = "Lidarr’s default"
  public static let defaultHelp = "Lidarr’s default is the root folder’s own setting, or the value in Playarr’s .env file when there is one."

  public init(api: any APISending, requestsChanged: @escaping @MainActor () -> Void = {}) {
    self.api = api
    self.requestsChanged = requestsChanged
  }

  public func load() async {
    do {
      info = try await api.send(API.Settings.requests())
      loadError = nil
    } catch {
      loadError = failureText(error)
    }
  }

  /// Retry after Lidarr's choices couldn't be fetched.
  public func retry() async {
    retrying = true
    defer { retrying = false }
    await load()
  }

  /// "Couldn’t get the choices from Lidarr: <why>", when Lidarr is set up but its lists didn't come.
  public var optionsProblem: String? {
    guard let info, info.lidarr, info.options == nil else { return nil }
    return "Couldn’t get the choices from Lidarr\(info.error.map { ": \($0)" } ?? ".")"
  }

  public var rootFolders: [Choice<String>] {
    choices(
      info?.rootFolderPath, info?.options?.rootFolders.map { folder in
        (folder.path, folder.freeSpace.map { "\(folder.path) · \(AdminText.bytes($0)) free" } ?? folder.path)
      } ?? [], missing: { $0 })
  }

  public var qualityProfiles: [Choice<Int>] {
    choices(info?.qualityProfileId, info?.options?.qualityProfiles.map { ($0.id, $0.name) } ?? [], missing: { "#\($0)" })
  }

  public var metadataProfiles: [Choice<Int>] {
    choices(info?.metadataProfileId, info?.options?.metadataProfiles.map { ($0.id, $0.name) } ?? [], missing: { "#\($0)" })
  }

  public func setEnabled(_ on: Bool) async { await save(RequestSettingsPatch(enabled: on)) { $0.enabled = on } }
  public func setSearchOnAdd(_ on: Bool) async { await save(RequestSettingsPatch(searchOnAdd: on)) { $0.searchOnAdd = on } }

  /// nil goes back to Lidarr's default (sent as null).
  public func setRootFolder(_ path: String?) async {
    await save(RequestSettingsPatch(rootFolderPath: .some(path))) { $0.rootFolderPath = path }
  }

  public func setQualityProfile(_ id: Int?) async {
    await save(RequestSettingsPatch(qualityProfileId: .some(id))) { $0.qualityProfileId = id }
  }

  public func setMetadataProfile(_ id: Int?) async {
    await save(RequestSettingsPatch(metadataProfileId: .some(id))) { $0.metadataProfileId = id }
  }

  private func choices<Value: Hashable>(_ saved: Value?, _ options: [(Value, String)], missing: (Value) -> String) -> [Choice<Value>] {
    var list = [Choice<Value>(value: nil, label: Self.defaultLabel)]
    // A choice Lidarr no longer has still shows, so it's clear why the default is used.
    if let saved, !options.contains(where: { $0.0 == saved }) {
      list.append(Choice(value: saved, label: "\(missing(saved)) (no longer in Lidarr)"))
    }
    list += options.map { Choice(value: $0.0, label: $0.1) }
    return list
  }

  private func save(_ patch: RequestSettingsPatch, _ apply: (inout RequestSettingsInfo) -> Void) async {
    guard var shown = info else { return }
    let previous = shown
    apply(&shown)
    info = shown
    do {
      info = try await api.send(API.Settings.saveRequests(patch))
      notice = nil
    } catch {
      info = previous
      notice = "Couldn’t save: \(failureText(error))"
    }
    // Request buttons follow GET /api/health's `requests`.
    requestsChanged()
  }
}
