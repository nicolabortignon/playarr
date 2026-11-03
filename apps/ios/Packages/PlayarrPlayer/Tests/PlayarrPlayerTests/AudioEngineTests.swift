import AVFoundation
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// The engine rendered offline (manual rendering mode): every join, fade and gain checked to the sample.
@MainActor
@Suite(.serialized)
struct AudioEngineTests {
  @Test func twoSongsJoinWithoutAGapToTheSample() async throws {
    let audio = try AudioEngine.offline([1: Signals.sine, 2: { n, c in Signals.sine(n, c) }])
    var events: [EngineEvent] = []
    audio.onEvent = { events.append($0) }
    let a = EngineItem(track: song(1, duration: 1)), b = EngineItem(track: song(2, duration: 1))
    audio.load(a, playing: true)
    audio.setUpcoming(b, join: .crossfade(seconds: 0))
    let out = try await audio.render(seconds: 2.1)
    let sine = { (n: Int) in Signals.sine(Int64(n), 0) }
    let lag = latency(of: out, matching: sine)
    // One continuous sine across the join at frame 44 100: any gap, overlap or click would break it.
    let worst = (40_000..<48_000).map { abs(out.left[$0 + lag] - sine($0 % 44_100)) }.max() ?? 1
    #expect(worst < 1e-4)
    #expect(events.contains(.advanced(b.id)))
    #expect(events.last == .ended(b.id))
  }

  @Test func aCrossfadeIsEqualPowerAndEndsWhereTheSongEnds() async throws {
    // A in the left ear only, B in the right only: the fade of each can be read off its own channel.
    let audio = try AudioEngine.offline([1: Signals.constant(0.4, 0), 2: Signals.constant(0, 0.4)])
    audio.load(EngineItem(track: song(1, duration: 3)), playing: true)
    audio.setUpcoming(EngineItem(track: song(2, duration: 3)), join: .crossfade(seconds: 1))
    let out = try await audio.render(seconds: 4)
    let lag = (0..<512).first { out.left[$0] > 0.2 } ?? 0
    let fadeStart = 2 * 44_100 + lag, fadeEnd = 3 * 44_100 + lag
    #expect(abs(out.left[fadeStart - 10] - 0.4) < 1e-4)
    #expect(out.right[fadeStart - 10] == 0)
    for i in stride(from: fadeStart, to: fadeEnd, by: 441) {
      let power = out.left[i] * out.left[i] + out.right[i] * out.right[i]
      #expect(abs(power - 0.16) < 1e-3)
    }
    #expect(abs(out.left[fadeStart + 22_050] - 0.4 * Float(0.5.squareRoot())) < 1e-3)
    #expect(abs(out.left[fadeEnd + 10]) < 1e-4)
    #expect(abs(out.right[fadeEnd + 10] - 0.4) < 1e-4)
  }

  @Test func gainsGoUpAsWellAsDownAndTheLimiterHoldsPeaksUnderMinusOneDB() async throws {
    let quiet = try AudioEngine.offline([1: Signals.constant(0.25, 0.25)])
    quiet.load(EngineItem(track: song(1, duration: 1), gainDb: 6), playing: true)
    let raised = try await quiet.render(seconds: 0.5)
    #expect(abs(raised.left[10_000] - 0.25 * Float(pow(10, 6.0 / 20))) < 1e-3)

    let loud = try AudioEngine.offline([1: { n, _ in Float(0.9 * sin(2 * .pi * 1000 * Double(n) / 44_100)) }])
    loud.load(EngineItem(track: song(1, duration: 2), gainDb: 6), playing: true)
    let limited = try await loud.render(seconds: 1.5)
    let peak = limited.left.dropFirst(4410).map(abs).max() ?? 1
    #expect(peak <= Float(pow(10, -1.0 / 20)) + 1e-4)
    #expect(peak > 0.8)
  }

  @Test func aSongThatFailsSaysWhyAndStops() async throws {
    struct Broken: PCMSource {
      func read(maxFrames: Int) async throws -> PCMBlock? { throw PlaybackError.unreachable }
      func close() async {}
    }
    let audio = try AudioEngine(manualRendering: true) { _, _ in Broken() }
    var events: [EngineEvent] = []
    audio.onEvent = { events.append($0) }
    let item = EngineItem(track: song(1))
    audio.load(item, playing: true)
    await audio.settle()
    #expect(events == [.failed(item.id, .unreachable)])
    #expect(audio.state == .idle)
  }

  @Test func pausingFreezesTheTimelineAndPlayGoesOnFromThere() async throws {
    let audio = try AudioEngine.offline([1: Signals.sine])
    audio.load(EngineItem(track: song(1, duration: 3)), playing: true)
    _ = try await audio.render(seconds: 1)
    audio.pause()
    #expect(audio.state == .paused)
    let position = audio.position
    #expect(try await audio.render(seconds: 1).frames == 0)
    audio.play()
    let out = try await audio.render(seconds: 0.5)
    let start = EngineFormat.frames(position)
    let lag = latency(of: out) { Signals.sine(Int64($0) + start, 0) }
    #expect(lag < 512)
  }
}
