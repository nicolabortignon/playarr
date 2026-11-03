import Foundation
import PlayarrAPI
import Synchronization

/// The demo library with Lidarr and one album to request (`-UITestsRequests`): what the requesting UI test runs
/// against, with no server. Signed in as an account that may request; "Heligoland" isn't in the library, is found by
/// Discover, is searching once requested, and in the library from the second look at the requests on.
public final class DemoRequestsAPI: APISending, Sendable {
  public static let account = Account(id: 2, username: "tester", name: "Tester", role: .member, canRequest: true, sources: nil, hasPassword: true)
  static let album = AlbumRef(mbid: "rg-heligoland", artistName: "Massive Attack", albumTitle: "Heligoland")

  private struct State {
    var requested = false
    /// Looks at the requests since the album was requested.
    var looks = 0
  }

  private let library = DemoAPI()
  private let state = Mutex(State())

  public init() {}

  public func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T {
    guard let answer = answer(endpoint.method, endpoint.path) else { return try await library.send(endpoint) }
    return try APIClient.decode(T.self, from: try JSONEncoder().encode(answer))
  }

  private func answer(_ method: HTTPMethod, _ path: String) -> (any Encodable & Sendable)? {
    switch (method, path) {
    case (.get, "/api/health"):
      var health = Demo.health
      health.lidarr = HealthStatus.Lidarr(ok: true, version: "2.9")
      health.requests = true
      return health
    case (.get, "/api/musicbrainz/status"):
      return MusicBrainzStatus(queued: 0, background: 0, etaSeconds: 0, matching: 0)
    case (.get, "/api/discover/search"):
      let album = DiscoverAlbum(
        mbid: Self.album.mbid ?? "", title: Self.album.albumTitle, artistName: Self.album.artistName, artistMbid: "art-1",
        year: 2010, type: "Album", secondaryTypes: [], availability: availability())
      return DiscoverResults(artists: [], albums: [album], tracks: [])
    case (.post, "/api/requests"):
      state.withLock { $0.requested = true }
      return request(Availability(state: .searching))
    case (.get, "/api/requests"):
      let requested = state.withLock { state in
        if state.requested { state.looks += 1 }
        return state.requested
      }
      return requested ? [request(availability())] : []
    default:
      return nil
    }
  }

  /// Not asked for yet; searching once asked; in the library from the second look at the requests on.
  private func availability() -> Availability {
    let (requested, looks) = state.withLock { ($0.requested, $0.looks) }
    guard requested else { return Availability(state: .noneValue) }
    return looks >= 2 ? Availability(state: .available) : Availability(state: .searching)
  }

  private func request(_ availability: Availability) -> AlbumRequest {
    AlbumRequest(
      mbid: Self.album.mbid ?? "", title: Self.album.albumTitle, artistName: Self.album.artistName, requestedAt: Demo.when,
      availability: availability)
  }
}
