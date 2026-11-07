import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrPlayer

/// A song's stream that plays `seconds`, then waits as a dead spot does until `gate` opens, and fails with `error`.
actor DeadSpotSource: PCMSource {
  private let inner: SignalSource
  private let breaksAt: Int64
  private let gate: Gate
  private let error: PlaybackError
  private var position: Int64

  init(seconds: Double, of duration: Double, from firstFrame: Int64, gate: Gate, error: PlaybackError) {
    inner = SignalSource(seconds: duration, from: firstFrame, signal: Signals.sine)
    breaksAt = EngineFormat.frames(seconds)
    position = firstFrame
    self.gate = gate
    self.error = error
  }

  func read(maxFrames: Int) async throws -> PCMBlock? {
    if position >= breaksAt {
      await gate.wait()
      throw error
    }
    let block = try await inner.read(maxFrames: min(maxFrames, Int(breaksAt - position)))
    position += Int64(block?.left.count ?? 0)
    return block
  }

  func close() async {}
}

/// Where each of song 1's streams started, in frames.
final class StreamStarts: Sendable {
  let frames = Mutex<[Int64]>([])
}

@MainActor
@Suite(.serialized)
struct PlayerDeadSpotTests {
  let gate = Gate()
  let starts = StreamStarts()

  /// Song 1's first stream breaks off a second in with `error`, once `gate` opens; every later one plays. The engine
  /// starts with half a second buffered, and a stalled song is tried again after 20 ms while online.
  func player(failing error: PlaybackError = .unreachable) throws -> Player {
    let directory = temporaryDirectory()
    let player = try Player(
      backend: FakeBackend(), directory: directory, settings: PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!),
      transport: FakeTransport(base: OfflineFolder(root: directory).base),
      makeEngine: { try AudioEngine(tuning: Self.quickStart, manualRendering: true, makeSource: $0) },
      makeSource: { [gate, starts] item, frame -> any PCMSource in
        guard item.track.id == 1 else { return SignalSource(seconds: item.track.duration, from: frame, signal: Signals.sine) }
        let first = starts.frames.withLock { frames in
          frames.append(frame)
          return frames.count == 1
        }
        return first
          ? DeadSpotSource(seconds: 1, of: item.track.duration, from: frame, gate: gate, error: error)
          : SignalSource(seconds: item.track.duration, from: frame, signal: Signals.sine)
      })
    player.settle = .zero
    player.stallRetries = [.milliseconds(20)]
    return player
  }

  /// Starts with half a second buffered, and buffers a tenth of a second before running dry.
  static var quickStart: AudioEngine.Tuning {
    var tuning = AudioEngine.Tuning()
    tuning.lowWater = 0.1
    tuning.highWater = 0.5
    return tuning
  }

  /// Plays song 1 into its dead spot: the music stops just before a second in, and the stream gives up.
  func breakOff(_ player: Player) async throws {
    player.play([song(1, duration: 10), song(2, duration: 10)])
    try await player.play(for: 1.5)
    await gate.open()
    await eventually { player.stalled != nil || player.error != nil }
  }

  @Test func offlineItWaitsWhereItStoppedAndPlaysOnOnceTheNetworkIsBack() async throws {
    let player = try player()
    player.network = { .offline }
    try await breakOff(player)
    let at = try #require(player.stalled?.at)
    // Where the music stopped: what was heard of the second the stream gave.
    #expect(at > 0.5 && at <= 1, "stalled at \(at)")
    #expect(player.error == nil)
    #expect(!player.queue.playing)
    #expect(player.queue.pos == 0)
    #expect(player.notice?.text == OfflinePlayback.stalledNotice)
    // Offline it isn't tried again: nothing changes until the network does.
    try await player.play(for: 0.5)
    #expect(player.time == at)
    #expect(starts.frames.withLock { $0.count } == 1)

    player.network = { .wifi }
    player.networkChanged(.wifi)
    #expect(player.queue.playing)
    try await player.play(for: 0.5)
    #expect(player.stalled == nil)
    // From where it stopped, as the same play.
    #expect(starts.frames.withLock { $0 } == [0, EngineFormat.frames(at)])
    #expect(player.time > at)
  }

  @Test func onlineItsTriedAgainAfterAWhile() async throws {
    let player = try player()
    try await breakOff(player)
    #expect(player.stalled?.tries == 1)
    #expect(player.error == nil)
    // After the wait it plays on by itself, from where it stopped.
    await eventually { player.queue.playing }
    #expect(player.queue.playing)
    try await player.play(for: 0.3)
    #expect(player.stalled == nil)
    #expect(starts.frames.withLock { $0.count } == 2)
  }

  @Test func anotherSongEndsTheWait() async throws {
    let player = try player()
    player.network = { .offline }
    try await breakOff(player)
    #expect(player.stalled != nil)
    player.next()
    #expect(player.stalled == nil)
    #expect(player.queue.pos == 1)
    player.network = { .wifi }
    player.networkChanged(.wifi)
    // Song 1 isn't taken back up.
    #expect(player.queue.pos == 1)
    #expect(starts.frames.withLock { $0.count } == 1)
  }

  @Test func aServersRefusalStillStopsAndSaysWhy() async throws {
    let player = try player(failing: .server("Unknown track file"))
    try await breakOff(player)
    #expect(player.stalled == nil)
    #expect(player.error == "Unknown track file")
    #expect(player.notice?.isError == true)
    #expect(!player.queue.playing)
  }
}
