import Foundation
import PlayarrAPI
import Synchronization

/// The demo library with Lidarr and one album to request (`-UITestsRequests`): what the requesting UI test runs
/// against, with no server. "Heligoland" isn't in the library and is found by Discover. As a member who may request,
/// it's searching once requested and in the library from the second look at the requests on, ready to play until
/// Requests has shown it. As a member who asks first (`-UITestsRequests asks-first`), it waits for approval, an admin
/// approves it by the second look and it lands two looks later; that member's request for "Blue Lines" was declined.
/// As an admin (`-UITestsRequests admin`), Sam's request for it waits for an answer: approved, it lands two looks later.
public final class DemoRequestsAPI: APISending, Sendable {
  /// Who the demo is signed in as, and so how its requests go.
  public enum Asker: String, Sendable, CaseIterable {
    /// A member whose requests go straight to Lidarr.
    case member
    /// A member whose requests wait for an admin's approval.
    case asksFirst = "asks-first"
    /// An admin, who answers everyone's requests.
    case admin

    /// `-UITestsRequests`, and the word after it when it names one.
    public init?(arguments: [String]) {
      guard let flag = arguments.firstIndex(of: "-UITestsRequests") else { return nil }
      self = arguments.indices.contains(flag + 1) ? Asker(rawValue: arguments[flag + 1]) ?? .member : .member
    }

    public var account: Account {
      switch self {
      case .member:
        Account(id: 2, username: "tester", name: "Tester", role: .member, canRequest: true, requestAccess: .on, sources: nil, hasPassword: true)
      case .asksFirst:
        Account(id: 2, username: "tester", name: "Tester", role: .member, canRequest: true, requestAccess: .ask, sources: nil, hasPassword: true)
      case .admin:
        Account(id: 1, username: "nicola", name: "Nicola", role: .admin, canRequest: true, requestAccess: .on, sources: nil, hasPassword: true)
      }
    }
  }

  /// The member who may request, as the requesting UI test signs in.
  public static let account = Asker.member.account
  static let album = AlbumRef(mbid: "rg-heligoland", artistName: "Massive Attack", albumTitle: "Heligoland")
  static let declined = AlbumRef(mbid: "rg-blue-lines", artistName: "Massive Attack", albumTitle: "Blue Lines")

  private enum Status { case waiting, approved, declined }

  private struct State {
    /// Heligoland's request: none until asked for (on an admin's demo, Sam's waits from the start).
    var status: Status?
    /// The demo's own account asked for it (Sam's alone doesn't make it the admin's).
    var mine = false
    /// Looks at the requests since it went to Lidarr, or since it started waiting.
    var looks = 0
    /// Blue Lines' declined request is still on the list (asks-first only).
    var declined = false
    /// What the account has seen since it was news, by MusicBrainz id.
    var seen: Set<String> = []
  }

  public let asker: Asker
  private let library = DemoAPI()
  private let state: Mutex<State>

  public init(_ asker: Asker = .member) {
    self.asker = asker
    state = Mutex(State(status: asker == .admin ? .waiting : nil, declined: asker == .asksFirst))
  }

  public func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T {
    guard let answer = answer(endpoint.method, endpoint.path, body: try endpoint.bodyData()) else { return try await library.send(endpoint) }
    return try APIClient.decode(T.self, from: try JSONEncoder().encode(answer))
  }

  private func answer(_ method: HTTPMethod, _ path: String, body: Data?) -> (any Encodable & Sendable)? {
    let heligoland = "/api/requests/\(Self.album.mbid ?? "")"
    switch (method, path) {
    case (.get, "/api/health"):
      var health = Demo.health
      health.lidarr = HealthStatus.Lidarr(ok: true, version: "2.9")
      health.requests = true
      return health
    case (.get, "/api/auth/me"):
      return asker.account
    case (.get, "/api/musicbrainz/status"):
      return MusicBrainzStatus(queued: 0, background: 0, etaSeconds: 0, matching: 0)
    case (.get, "/api/discover/search"):
      let album = DiscoverAlbum(
        mbid: Self.album.mbid ?? "", title: Self.album.albumTitle, artistName: Self.album.artistName, artistMbid: "art-1",
        year: 2010, type: "Album", secondaryTypes: [], availability: state.withLock { Self.discovered($0) })
      return DiscoverResults(artists: [], albums: [album], tracks: [])
    case (.post, "/api/requests"):
      return state.withLock { state in
        // An admin's request sends one waiting for approval on; a member's who asks first waits as Sam's would.
        if state.status != .approved {
          state.status = asker == .asksFirst ? .waiting : .approved
          state.looks = 0
        }
        state.mine = true
        return heligolandRequest(state, fresh: true)
      }
    case (.get, "/api/requests"):
      return state.withLock { state in
        look(&state)
        return list(state)
      }
    case (.post, "/api/requests/seen"):
      let mbids = body.flatMap { try? JSONDecoder().decode(RequestsSeen.self, from: $0) }?.mbids ?? []
      state.withLock { $0.seen.formUnion(mbids) }
      return NoBody()
    case (.post, heligoland + "/approve"), (.post, heligoland + "/decline"):
      return state.withLock { state in
        state.status = path.hasSuffix("/approve") ? .approved : .declined
        state.looks = 0
        return heligolandRequest(state, fresh: true)
      }
    case (.delete, heligoland):
      state.withLock { state in
        state.status = nil
        state.seen.remove(Self.album.mbid ?? "")
      }
      return NoBody()
    case (.delete, "/api/requests/\(Self.declined.mbid ?? "")"):
      state.withLock { $0.declined = false }
      return NoBody()
    default:
      return nil
    }
  }

  /// One more look at the requests: a request on its way gets nearer, and an asks-first member's is approved by the
  /// second look while it waits.
  private func look(_ state: inout State) {
    guard state.status != nil else { return }
    state.looks += 1
    if asker == .asksFirst, state.status == .waiting, state.looks >= 2 {
      state.status = .approved
      state.looks = 0
    }
  }

  private func list(_ state: State) -> [AlbumRequest] {
    var list: [AlbumRequest] = []
    if state.status != nil { list.append(heligolandRequest(state, fresh: false)) }
    if state.declined {
      list.append(
        AlbumRequest(
          mbid: Self.declined.mbid ?? "", title: Self.declined.albumTitle, artistName: Self.declined.artistName, requestedAt: Demo.when,
          availability: Availability(state: .failed, message: "Declined by Nicola"), mine: true, approval: .declined,
          unseen: !state.seen.contains(Self.declined.mbid ?? "")))
    }
    return list
  }

  /// Heligoland's request as the account sees it: on an admin's list, whose it is.
  private func heligolandRequest(_ state: State, fresh: Bool) -> AlbumRequest {
    let mbid = Self.album.mbid ?? ""
    let availability: Availability
    let approval: RequestApproval?
    switch state.status {
    case .waiting:
      availability = Availability(state: .waiting, message: "Waiting for approval")
      approval = .waiting
    case .declined:
      availability = Availability(state: .failed, message: "Declined by you")
      approval = .declined
    case .approved, nil:
      availability = fresh || state.looks < 2 ? Availability(state: .searching) : Availability(state: .available)
      approval = nil
    }
    let arrived = availability.state == .available
    return AlbumRequest(
      mbid: mbid, title: Self.album.albumTitle, artistName: Self.album.artistName, requestedAt: Demo.when, availability: availability,
      mine: asker == .admin ? state.mine : true, askedBy: asker == .admin ? ["Sam"] : nil, approval: approval,
      // News to whoever asked: arrived since Requests last showed it.
      unseen: arrived && (asker != .admin || state.mine) && !state.seen.contains(mbid))
  }

  /// A 204: `NoContent` decodes from it.
  private struct NoBody: Encodable, Sendable {}

  /// What Discover says of Heligoland: only a request that went to Lidarr counts (to everyone else, one waiting for
  /// approval is still to be asked for).
  private static func discovered(_ state: State) -> Availability {
    guard state.status == .approved else { return Availability(state: .noneValue) }
    return state.looks >= 2 ? Availability(state: .available) : Availability(state: .searching)
  }
}
