import PlayarrAPI

/// Notices requests that became playable since the last look (useWatchRequests). Nothing counts until there was a
/// list to compare with, so opening the app with albums already in doesn't announce them.
public struct RequestWatch: Sendable {
  private var previous: [String: AvailabilityState] = [:]

  public init() {}

  public mutating func landed(in requests: [AlbumRequest]) -> [AlbumRequest] {
    let landed = previous.isEmpty ? [] : requests.filter { $0.availability.state == .available && previous[$0.mbid] != .available }
    previous = Dictionary(requests.map { ($0.mbid, $0.availability.state) }, uniquingKeysWith: { first, _ in first })
    return landed
  }

  /// "“Mezzanine” is ready to play", "2 albums are ready to play".
  public static func message(for landed: [AlbumRequest]) -> String? {
    switch landed.count {
    case 0: nil
    case 1: "“\(landed[0].title)” is ready to play"
    default: "\(landed.count) albums are ready to play"
    }
  }
}
