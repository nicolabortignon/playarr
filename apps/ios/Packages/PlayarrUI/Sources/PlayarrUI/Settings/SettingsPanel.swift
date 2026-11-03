/// Settings' panels (apps/web/src/pages/Settings.tsx), minus Profiles (accounts replaced them) and Your listening
/// (a page of its own here). Playback and Appearance are this device's; the rest are the server's, for admins.
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

  /// The server's settings, shown to admins (built in phase 9).
  public static let server: [SettingsPanel] = [.sources, .mixes, .analysis, .requests, .updates, .accounts]
}
