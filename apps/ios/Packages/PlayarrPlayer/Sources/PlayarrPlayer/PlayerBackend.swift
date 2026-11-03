import Foundation
import PlayarrAPI

/// What the player needs from the server: one seam, so the Player is tested against a fake.
public protocol PlayerBackend: Sendable {
  func levels(_ recordingIds: [String]) async throws -> [String: TrackLevel]
  func reportPlays(_ plays: [PlayReport]) async throws
  func radio(seeds: [String], exclude: [String], count: Int) async throws -> [Track]
  /// The song's own file, authorized.
  func streamRequest(_ track: Track) -> URLRequest
  /// The song's levelled stream at gain 0 (the phone applies the gain), authorized.
  func levelledRequest(_ track: Track) -> URLRequest
  func artwork(_ track: Track, size: Int) async -> Data?
  /// `POST /api/transitions`.
  func transition(_ request: TransitionRequest) async throws -> TransitionAnswer
  /// `POST /api/mix-maps`, at most 50 at a time.
  func mixMaps(_ recordingIds: [String]) async throws -> [String: MixMapEntry]
  /// A transition file or the rest of a song after one (a path the server gave, `/transitions/…`), authorized.
  func transitionRequest(_ path: String) -> URLRequest
}

/// The real server, through PlayarrAPI.
public struct APIBackend: PlayerBackend {
  let client: APIClient
  let media: MediaURLs
  let session: URLSession

  public init(client: APIClient, media: MediaURLs, session: URLSession = .shared) {
    self.client = client
    self.media = media
    self.session = session
  }

  public func levels(_ recordingIds: [String]) async throws -> [String: TrackLevel] {
    try await client.send(API.Playback.levels(ids: recordingIds))
  }

  public func reportPlays(_ plays: [PlayReport]) async throws {
    _ = try await client.send(API.Playback.reportPlays(plays))
  }

  public func radio(seeds: [String], exclude: [String], count: Int) async throws -> [Track] {
    try await client.send(API.Playback.radio(seeds: seeds, exclude: exclude, count: count))
  }

  // A server address that can't take the path (never, for a URL that signed in) asks the server's root: the
  // request fails and is explained like any other.
  public func streamRequest(_ track: Track) -> URLRequest {
    media.request(for: media.stream(fileId: track.fileId) ?? media.baseURL)
  }

  public func levelledRequest(_ track: Track) -> URLRequest {
    media.request(for: media.levelled(track, gain: 0) ?? media.baseURL)
  }

  public func transition(_ request: TransitionRequest) async throws -> TransitionAnswer {
    try await client.send(API.Playback.transition(request))
  }

  public func mixMaps(_ recordingIds: [String]) async throws -> [String: MixMapEntry] {
    try await client.send(API.Playback.mixMaps(ids: recordingIds))
  }

  public func transitionRequest(_ path: String) -> URLRequest {
    media.request(for: media.transition(path) ?? media.baseURL)
  }

  public func artwork(_ track: Track, size: Int) async -> Data? {
    guard let url = media.art(track.coverUrl, size: size),
      let (data, response) = try? await session.data(for: media.request(for: url)),
      (response as? HTTPURLResponse)?.statusCode == 200
    else { return nil }
    return data
  }
}
