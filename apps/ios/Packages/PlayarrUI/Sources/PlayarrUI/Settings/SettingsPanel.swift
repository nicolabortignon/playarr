import PlayarrAPI

/// Settings' panels (apps/web/src/pages/Settings.tsx), minus Profiles (accounts replaced them) and Your listening
/// (a page of its own here). Playback and Appearance are this device's; the rest are the server's. Sources, Analysis,
/// Requests and Updates are for admins; a member sees Accounts (their own name and devices) and Mixes (their own
/// listening history and ListenBrainz).
public enum SettingsPanel: String, Hashable, Sendable, CaseIterable {
  case playback, appearance, sources, mixes, analysis, requests, updates, accounts
  #if DEBUG
    case playerLab = "player-lab"
  #endif

  public var title: String {
    switch self {
    case .playback: "Playback"
    case .appearance: "Appearance"
    case .sources: "Sources"
    case .mixes: "Mixes"
    case .analysis: "Analysis"
    case .requests: "Requests"
    case .updates: "Updates"
    case .accounts: "Accounts"
    #if DEBUG
      case .playerLab: "Player lab"
    #endif
    }
  }

  /// The server's settings, in the web's order.
  public static let server: [SettingsPanel] = [.sources, .accounts, .mixes, .analysis, .requests, .updates]

  /// The server's panels this role may open.
  public static func server(for role: AccountRole) -> [SettingsPanel] {
    server.filter { $0.isVisible(to: role) }
  }

  public func isVisible(to role: AccountRole) -> Bool {
    switch self {
    case .sources, .analysis, .requests, .updates: role == .admin
    default: true
    }
  }
}
