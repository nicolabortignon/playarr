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
}

extension Player {
  /// A Player on an offline engine whose songs are 441 Hz sines (see `Signals`).
  static func testing(_ backend: FakeBackend = FakeBackend(), directory: URL = temporaryDirectory(), settings: PlaybackSettings? = nil) throws -> Player {
    let defaults = UserDefaults(suiteName: UUID().uuidString)!
    return try Player(
      backend: backend, directory: directory, settings: settings ?? PlaybackSettings(defaults: defaults),
      makeEngine: { try AudioEngine(manualRendering: true, makeSource: $0) },
      makeSource: { item, frame in SignalSource(seconds: item.track.duration, from: frame, signal: Signals.sine) })
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
