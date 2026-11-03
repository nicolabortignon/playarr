import Foundation
import PlayarrAPI
import PlayarrPlayer

/// The player's server in the demo and tests: radio from the demo library, no levels, plays kept to itself.
public struct DemoPlayerBackend: PlayerBackend {
  let api: any APISending

  public init(api: any APISending) {
    self.api = api
  }

  public func levels(_ recordingIds: [String]) async throws -> [String: TrackLevel] { [:] }
  public func reportPlays(_ plays: [PlayReport]) async throws {}
  public func radio(seeds: [String], exclude: [String], count: Int) async throws -> [Track] {
    try await api.send(API.Playback.radio(seeds: seeds, exclude: exclude, count: count))
  }
  public func streamRequest(_ track: Track) -> URLRequest { URLRequest(url: Demo.baseURL.appending(path: track.streamUrl)) }
  public func levelledRequest(_ track: Track) -> URLRequest { streamRequest(track) }
  public func artwork(_ track: Track, size: Int) async -> Data? { nil }
  /// The demo has no analysis, so no mixes: DJ mix cuts or plays gapless.
  public func transition(_ request: TransitionRequest) async throws -> TransitionAnswer {
    .unavailable(.init(reason: "Mixed transitions need audio analysis"))
  }
  public func mixMaps(_ recordingIds: [String]) async throws -> [String: MixMapEntry] { [:] }
  public func transitionRequest(_ path: String) -> URLRequest { URLRequest(url: Demo.baseURL.appending(path: path)) }
}
