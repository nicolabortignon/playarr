import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// A song's stream that plays `seconds`, then gives nothing more until `gate` opens: a connection too slow for it.
actor StarvingSource: PCMSource {
  private let inner: SignalSource
  private let dryAt: Int64
  private let gate: Gate
  private var position: Int64

  init(seconds: Double, of duration: Double, from firstFrame: Int64, gate: Gate) {
    inner = SignalSource(seconds: duration, from: firstFrame, signal: Signals.sine)
    dryAt = EngineFormat.frames(seconds)
    position = firstFrame
    self.gate = gate
  }

  func read(maxFrames: Int) async throws -> PCMBlock? {
    if position >= dryAt {
      await gate.wait()
      throw CancellationError()
    }
    let block = try await inner.read(maxFrames: min(maxFrames, Int(dryAt - position)))
    position += Int64(block?.left.count ?? 0)
    return block
  }

  func close() async {}
}

/// Automatic quality in the player: a song that keeps running dry goes on a quality lower from where it was.
@MainActor
@Suite(.serialized)
struct PlayerAutoQualityTests {
  let gate = Gate()
  let starts = StreamStarts()
  let flac = encodable(song(1, duration: 10))

  /// Song 1's first stream runs dry a second in; every later one plays. Measured at 20 Mbps: it starts at Original.
  func player(streaming: StreamingChoice = .automatic) throws -> Player {
    let directory = temporaryDirectory()
    let settings = PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!)
    settings.streaming = streaming
    let player = try Player(
      backend: FakeBackend(), directory: directory, settings: settings, transport: FakeTransport(base: OfflineFolder(root: directory).base),
      makeEngine: { try AudioEngine(tuning: PlayerDeadSpotTests.quickStart, manualRendering: true, makeSource: $0) },
      makeSource: { [gate, starts] item, frame -> any PCMSource in
        guard item.track.id == 1 else { return SignalSource(seconds: item.track.duration, from: frame, signal: Signals.sine) }
        let first = starts.frames.withLock { frames in
          frames.append(frame)
          return frames.count == 1
        }
        return first
          ? StarvingSource(seconds: 1, of: item.track.duration, from: frame, gate: gate)
          : SignalSource(seconds: item.track.duration, from: frame, signal: Signals.sine)
      })
    player.settle = .zero
    player.bandwidth.reset(to: 20_000)
    return player
  }

  /// Renders and ticks `seconds` in steps of 0.1 s, the clock moving as much each time.
  func play(_ player: Player, for seconds: Double, from now: inout Date) async throws {
    for _ in 0..<Int((seconds * 10).rounded()) {
      _ = try await player.engine.render(seconds: 0.1)
      now += 0.1
      player.tick(now: now)
    }
  }

  @Test func aSongThatKeepsRunningDryPlaysOnAQualityLowerFromWhereItWas() async throws {
    let player = try player()
    #expect(player.encodedQuality(of: flac) == nil)  // Original: its own file
    player.play([flac, encodable(song(2, duration: 10))])
    var now = Date()
    // A second of music, then three of waiting for the song.
    try await play(player, for: 4.5, from: &now)
    let frames = starts.frames.withLock { $0 }
    #expect(frames.count == 2)
    let at = EngineFormat.seconds(frames.last ?? 0)
    #expect(at > 0.5 && at <= 1, "went on from \(at)")
    // The same song, the same play, from where it was, at High: the connection is held below the FLAC's 900 kbps.
    #expect(player.queue.pos == 0)
    #expect(player.encodedQuality(of: flac) == .high)
    #expect(try #require(player.bandwidth.estimate()) < 900)
    try await play(player, for: 1, from: &now)
    #expect(player.time > at + 0.5)
    #expect(player.starved == 0)
    await gate.open()
  }

  @Test func aQualityPickedHoldsHoweverLongTheMusicWaits() async throws {
    let player = try player(streaming: .original)
    player.play([flac])
    var now = Date()
    try await play(player, for: 6, from: &now)
    #expect(starts.frames.withLock { $0.count } == 1)
    #expect(player.bandwidth.estimate() == 20_000)
    await gate.open()
  }
}
