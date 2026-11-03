import PlayarrAPI

/// How often the requests are asked for: every 10 s while any is on its way, every minute otherwise (useRequests).
public enum RequestPolling {
  public static let activeStates: Set<AvailabilityState> = [.searching, .downloading, .importing]
  public static let whileActive: Duration = .seconds(10)
  public static let otherwise: Duration = .seconds(60)

  public static func interval(after requests: [AlbumRequest]?) -> Duration {
    activeCount(requests) > 0 ? whileActive : otherwise
  }

  /// Requests Lidarr is searching for, downloading or importing ("2 requests in progress").
  public static func activeCount(_ requests: [AlbumRequest]?) -> Int {
    requests?.filter { activeStates.contains($0.availability.state) }.count ?? 0
  }
}
