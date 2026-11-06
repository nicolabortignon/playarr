import PlayarrAPI

/// Settings' panels (apps/web/src/pages/Settings.tsx), minus Profiles (accounts replaced them). Playback and Appearance
/// are this device's; the rest are the server's. Your listening isn't a setting: it's in Library and the account menu.
public enum SettingsPanel: String, Hashable, Sendable, CaseIterable, Codable {
  case playback, appearance, sources, mixes, analysis, requests, updates, accounts
  #if DEBUG
    case playerLab = "player-lab"
  #endif

  public var title: String {
    switch self {
    case .playback: "Playback"
    case .appearance: "Appearance"
    case .sources: "Sources"
    case .mixes: "Made for you"
    case .analysis: "Analysis"
    case .requests: "Requests"
    case .updates: "Updates"
    case .accounts: "Accounts"
    #if DEBUG
      case .playerLab: "Player lab"
    #endif
    }
  }
}

/// A group of Settings' list (docs/design.md, "Patterns"): This device · Your account · Server, named and ordered as
/// the web's. An admin has this device's, then the server's; a member has this device's, their account's (their name
/// and devices, their mixes and ListenBrainz), then the server's, which they can read but not change.
public struct SettingsGroup: Equatable, Sendable {
  public let title: String
  public let panels: [SettingsPanel]
  /// The line under the group: whom it's for, or who can change it.
  public let note: String?

  public static let thisDevice = "These settings are for this device."
  public static let everyone = "These settings apply to everyone."
  public static let adminOnly = "Only an admin can change these."

  public static func groups(for role: AccountRole) -> [SettingsGroup] {
    let device = SettingsGroup(title: "This device", panels: [.playback, .appearance], note: thisDevice)
    guard role != .admin else {
      return [device, SettingsGroup(title: "Server", panels: [.sources, .accounts, .mixes, .analysis, .requests, .updates], note: everyone)]
    }
    return [
      device,
      SettingsGroup(title: "Your account", panels: [.accounts, .mixes], note: nil),
      SettingsGroup(title: "Server", panels: [.sources, .analysis, .requests, .updates], note: adminOnly),
    ]
  }
}
