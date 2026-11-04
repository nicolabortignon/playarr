import Foundation
import Observation
import PlayarrAPI

/// Name, username, role, requests, what it may change on its devices and library: for a new account, or to change one
/// (AccountsPanel.tsx: AccountForm).
@MainActor @Observable
public final class AccountFormModel {
  public let account: Account?
  public var name: String
  public var username: String
  public var role: AccountRole
  public var canRequest: Bool
  public var everySource: Bool
  public private(set) var picked: [Int]
  /// The device settings it may not change (asked for members only).
  public private(set) var locked: [DeviceSetting]
  /// The sources to pick from, in their priority order.
  public let sources: [SourceInfo]

  /// The server's rule (apps/server/src/accounts/username.ts), after lowercasing.
  static let usernamePattern = /^[a-z0-9][a-z0-9._-]{0,31}$/
  public static let usernameRule = "A username is 1 to 32 lowercase letters, digits, dots, dashes or underscores"

  public init(account: Account?, sources: [SourceInfo]) {
    self.account = account
    self.sources = sources
    name = account?.name ?? ""
    username = account?.username ?? ""
    role = account?.role ?? .member
    canRequest = account?.canRequest ?? true
    everySource = account.map { $0.sources == nil } ?? true
    picked = account?.sources ?? []
    locked = account?.locked ?? []
  }

  /// The device settings an admin can stop a member from changing, as the form names them.
  public static let deviceSettings: [(setting: DeviceSetting, label: String)] = [(.playback, "Playback"), (.appearance, "Appearance")]

  public func mayChange(_ setting: DeviceSetting) -> Bool { !locked.contains(setting) }

  public func setMayChange(_ setting: DeviceSetting, _ may: Bool) {
    locked.removeAll { $0 == setting }
    if !may { locked.append(setting) }
  }

  /// As the server keeps them: in the form's order.
  var chosenLocked: [DeviceSetting] { Self.deviceSettings.map(\.setting).filter(locked.contains) }

  public func isPicked(_ source: SourceInfo) -> Bool { picked.contains(source.id) }

  public func toggle(_ source: SourceInfo) {
    if let index = picked.firstIndex(of: source.id) { picked.remove(at: index) } else { picked.append(source.id) }
  }

  var cleanUsername: String { username.trimmed.lowercased() }

  /// Shown under the username once it can't be one.
  public var usernameProblem: String? {
    guard !username.trimmed.isEmpty, cleanUsername.wholeMatch(of: Self.usernamePattern) == nil else { return nil }
    return Self.usernameRule
  }

  public var canSubmit: Bool {
    !name.trimmed.isEmpty && name.trimmed.count <= 40 && !username.trimmed.isEmpty && usernameProblem == nil
  }

  /// The library as the server wants it: nil for every source, else the picked ones in the list's order.
  var chosenSources: [Int]? {
    everySource ? nil : sources.map(\.id).filter(picked.contains) + picked.filter { id in !sources.contains { $0.id == id } }
  }

  /// POST /api/accounts.
  public var createEndpoint: Endpoint<CreatedAccount> {
    API.Accounts.create(username: cleanUsername, name: name.trimmed, role: role, canRequest: canRequest, sources: chosenSources, locked: chosenLocked)
  }

  /// PATCH /api/accounts/:id with only what changed; nil when nothing did.
  public var patch: AccountPatch? {
    guard let account else { return nil }
    var patch = AccountPatch()
    if cleanUsername != account.username { patch.username = cleanUsername }
    if name.trimmed != account.name { patch.name = name.trimmed }
    if role != account.role { patch.role = role }
    if canRequest != account.canRequest { patch.canRequest = canRequest }
    if chosenSources != account.sources { patch.sources = .some(chosenSources) }
    if chosenLocked != (account.locked ?? []) { patch.locked = chosenLocked }
    return patch == AccountPatch() ? nil : patch
  }
}
