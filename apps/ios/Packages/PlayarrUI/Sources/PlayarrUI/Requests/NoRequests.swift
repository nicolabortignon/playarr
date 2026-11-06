import PlayarrAPI

/// What Requests says with nothing on it (docs/design.md, "What isn't possible here"; pages/Requests.tsx NoRequests):
/// where asking is possible, how to ask; where it isn't, why and who can change it, never a button that leads nowhere.
/// An admin is offered the way to change it, a member told that an admin can.
enum NoRequests: Equatable, Sendable {
  /// Lidarr, and requests on for this account: how to ask for an album.
  case ask
  /// No Lidarr source.
  case needsLidarr(admin: Bool)
  /// This account may not request.
  case cantRequest(admin: Bool)
  /// Requests are turned off on the server.
  case turnedOff(admin: Bool)

  /// Where to go to change it.
  enum Destination: Equatable, Sendable {
    case search
    case settings(SettingsPanel)
  }

  struct Action: Equatable, Sendable {
    let title: String
    let systemImage: String
    let destination: Destination
  }

  /// From what the server says it allows (`gate`, once its health is known) and who's asking.
  static func of(_ gate: RequestGate, admin: Bool) -> NoRequests {
    if !gate.hasLidarr { return .needsLidarr(admin: admin) }
    if !gate.canRequest { return .cantRequest(admin: admin) }
    return gate.allowsRequests ? .ask : .turnedOff(admin: admin)
  }

  var line: PageLines.Line {
    switch self {
    case .ask:
      PageLines.Line("Ask for an album you don’t have.", "Search for it and press Request: it lands in your library once Lidarr finds it.")
    case .needsLidarr(true):
      PageLines.Line("Requests need a Lidarr source.", "Add one, and you can ask Lidarr for albums you don’t have, right from Search.")
    case .needsLidarr(false):
      PageLines.Line("Requests aren’t set up on this server.", "They need a Lidarr source, which an admin can add.")
    case .cantRequest(let admin):
      PageLines.Line("Your account can’t request albums.", admin ? "Allow it for yourself in Settings → Accounts." : "An admin can allow it.")
    case .turnedOff(true):
      PageLines.Line("Requests are turned off.", "Nobody can ask Lidarr for albums until they’re on again.")
    case .turnedOff(false):
      PageLines.Line("Requests are turned off on this server.", "An admin can turn them on.")
    }
  }

  var action: Action? {
    switch self {
    case .ask: Action(title: "Search", systemImage: "magnifyingglass", destination: .search)
    case .needsLidarr(true): Action(title: "Add Lidarr", systemImage: "gearshape", destination: .settings(.sources))
    case .turnedOff(true): Action(title: "Turn them on", systemImage: "gearshape", destination: .settings(.requests))
    default: nil
    }
  }
}
