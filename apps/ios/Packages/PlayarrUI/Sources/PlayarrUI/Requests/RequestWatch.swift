import PlayarrAPI

/// Notices what changed in the requests since the last look (useWatchRequests, lib/queries.ts requestChanges): those that
/// became playable, and others' newly waiting for an admin's answer (only an admin's list holds others'). Nothing counts
/// until there was a list to compare with, so opening the app with albums already in doesn't announce them; after that,
/// a request first seen already there does (another device asked, or someone asked between two looks).
public struct RequestWatch: Sendable {
  private var previous: [String: AlbumRequest]?

  public init() {}

  /// What changed since the last look.
  public struct Changes: Equatable, Sendable {
    /// Became playable: the library has them now, whoever asked.
    public var landed: [AlbumRequest] = []
    /// Asked for by someone else and waiting for an admin's answer.
    public var waiting: [AlbumRequest] = []

    /// The landed the account asked for itself (on servers that predate ownership, every one: they were everyone's).
    public var landedForYou: [AlbumRequest] { landed.filter { $0.mine != false } }
  }

  public mutating func changes(in requests: [AlbumRequest]) -> Changes {
    defer { previous = Dictionary(requests.map { ($0.mbid, $0) }, uniquingKeysWith: { first, _ in first }) }
    guard let previous else { return Changes() }
    return Changes(
      landed: requests.filter { $0.availability.state == .available && previous[$0.mbid]?.availability.state != .available },
      waiting: requests.filter { $0.approval == .waiting && $0.mine == false && previous[$0.mbid]?.approval != .waiting })
  }

  /// "“Mezzanine” is ready to play", "2 albums are ready to play".
  public static func message(for landed: [AlbumRequest]) -> String? {
    switch landed.count {
    case 0: nil
    case 1: "“\(landed[0].title)” is ready to play"
    default: "\(landed.count) albums are ready to play"
    }
  }

  /// "Sam asked for “Heligoland”", "2 albums are waiting for your approval".
  public static func waitingMessage(for waiting: [AlbumRequest]) -> String? {
    guard let first = waiting.first else { return nil }
    if waiting.count > 1 { return "\(waiting.count) albums are waiting for your approval" }
    guard let who = first.askedBy?.first else { return "“\(first.title)” is waiting for your approval" }
    return "\(who) asked for “\(first.title)”"
  }
}
