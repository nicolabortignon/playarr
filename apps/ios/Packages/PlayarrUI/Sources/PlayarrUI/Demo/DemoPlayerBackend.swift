import Foundation
import PlayarrAPI
import PlayarrPlayer

/// The player's server in the demo and tests: radio from the demo library, no levels, plays kept to itself, the demo
/// songs' mix maps (`Demo.mixMap`).
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
  /// The demo renders no transitions, but plans them from its songs' mix maps: a quick mix out of the last bars of the
  /// song playing (none within an album played in order, as the server's). Its file can't be fetched, so the phone
  /// plays the quick mix itself, live, as it does when a server's file is late.
  public func transition(_ request: TransitionRequest) async throws -> TransitionAnswer {
    guard request.albumQueue != true, let a = Demo.tracks.first(where: { $0.id == request.from }),
      let b = Demo.tracks.first(where: { $0.id == request.to }), let mapA = Demo.mixMap(a), let mapB = Demo.mixMap(b)
    else { return .unavailable(.init(reason: "Mixed transitions need audio analysis")) }
    let plan = SkipPlanner.plan(a: mapA, b: mapB, mode: request.mode, at: a.duration - Self.mixFromEnd)
    guard plan.style == .quick else { return .straight(.init(plan: plan)) }
    return .ready(.init(plan: plan, url: "/transitions/demo-\(a.id)-\(b.id).flac"))
  }

  /// How long before a song's end the demo's quick mixes start, about.
  static let mixFromEnd = 16.0
  public func mixMaps(_ recordingIds: [String]) async throws -> [String: MixMapEntry] { Demo.mixMaps(recordingIds) }
  public func transitionRequest(_ path: String) -> URLRequest { URLRequest(url: Demo.baseURL.appending(path: path)) }
}
