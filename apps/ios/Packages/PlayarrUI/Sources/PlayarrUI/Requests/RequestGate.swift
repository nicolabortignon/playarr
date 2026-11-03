import PlayarrAPI

/// Who may see Discover and press Request. Until the server's health is known it doesn't hide anything the account
/// may use, as the web (useHasLidarr, useRequestsEnabled); the server refuses what isn't allowed anyway.
public struct RequestGate: Equatable, Sendable {
  /// A Lidarr source is set up: Discover and requests exist on this server.
  public var hasLidarr: Bool
  /// Request buttons show: Lidarr, requests on in Settings, and this account may request (`health.requests` says
  /// all three for the signed-in account; `canRequest` is checked too so a change shows before the next health).
  public var allowsRequests: Bool
  /// The account may request and withdraw requests (DELETE /api/requests needs only this).
  public var canRequest: Bool

  public init(health: HealthStatus?, account: Account?) {
    canRequest = account?.canRequest ?? false
    hasLidarr = health.map { $0.lidarr != nil } ?? true
    allowsRequests = canRequest && (health?.requests ?? true)
  }
}
