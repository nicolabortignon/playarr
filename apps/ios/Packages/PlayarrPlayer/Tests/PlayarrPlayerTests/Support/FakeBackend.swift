import Foundation
import PlayarrAPI
import Synchronization
@testable import PlayarrPlayer

/// The server, as the Player sees it, for tests.
final class FakeBackend: PlayerBackend {
  let levelTable = Mutex<[String: TrackLevel]>([:])
  let plays = Mutex<[PlayReport]>([])
  let radioAnswer = Mutex<[Track]>([])
  let radioAsks = Mutex<[(seeds: [String], exclude: [String])]>([])

  func levels(_ recordingIds: [String]) async throws -> [String: TrackLevel] {
    levelTable.withLock { table in table.filter { recordingIds.contains($0.key) } }
  }
  func reportPlays(_ reported: [PlayReport]) async throws { plays.withLock { $0 += reported } }
  func radio(seeds: [String], exclude: [String], count: Int) async throws -> [Track] {
    radioAsks.withLock { $0.append((seeds, exclude)) }
    return radioAnswer.withLock { $0 }
  }
  func streamRequest(_ track: Track) -> URLRequest { StubServer.request(track.streamUrl) }
  func levelledRequest(_ track: Track) -> URLRequest { StubServer.request(track.streamUrl + "/levelled.wav") }
  func artwork(_ track: Track, size: Int) async -> Data? { nil }

  /// Answers for POST /api/transitions by "<from id>-<to id>", in turn (the last one repeats); unavailable otherwise.
  let transitionAnswers = Mutex<[String: [TransitionAnswer]]>([:])
  let transitionAsks = Recorder<TransitionRequest>()
  let mixMapTable = Mutex<[String: MixMapEntry]>([:])

  func transition(_ request: TransitionRequest) async throws -> TransitionAnswer {
    transitionAsks.append(request)
    return transitionAnswers.withLock { table in
      let key = "\(request.from)-\(request.to)"
      guard let answers = table[key], let first = answers.first else { return .unavailable(.init(reason: "No mix map yet")) }
      if answers.count > 1 { table[key] = Array(answers.dropFirst()) }
      return first
    }
  }
  func mixMaps(_ recordingIds: [String]) async throws -> [String: MixMapEntry] {
    mixMapTable.withLock { table in table.filter { recordingIds.contains($0.key) } }
  }
  func transitionRequest(_ path: String) -> URLRequest { StubServer.request(path) }
}

extension Player {
  /// A Player on an offline engine whose songs are 441 Hz sines (see `Signals`).
  static func testing(
    _ backend: FakeBackend = FakeBackend(), directory: URL = temporaryDirectory(), settings: PlaybackSettings? = nil,
    scheduler: (any Scheduling)? = nil, signals: [Int: @Sendable (Int64, Int) -> Float] = [:]
  ) throws -> Player {
    let defaults = UserDefaults(suiteName: UUID().uuidString)!
    return try Player(
      backend: backend, directory: directory, settings: settings ?? PlaybackSettings(defaults: defaults),
      makeEngine: { try AudioEngine(manualRendering: true, makeSource: $0) },
      makeSource: { item, frame in SignalSource(seconds: item.track.duration, from: frame, signal: signals[item.track.id] ?? Signals.sine) },
      scheduler: scheduler)
  }

  /// Renders `seconds` in steps of 0.1 s, ticking the Player's clock between them.
  func play(for seconds: Double) async throws {
    for _ in 0..<Int((seconds * 10).rounded()) {
      _ = try await engine.render(seconds: 0.1)
      tick()
    }
  }
}

/// Waits (up to a second) for something another task does.
@MainActor
func eventually(_ condition: () -> Bool) async {
  for _ in 0..<1000 where !condition() { try? await Task.sleep(for: .milliseconds(1)) }
}
