import AVFoundation
import Foundation
@testable import PlayarrPlayer

/// A synthetic song: `signal(frame)` per channel for `seconds`, from `firstFrame` on (as a seek would ask).
actor SignalSource: PCMSource {
  let total: Int64
  let signal: @Sendable (Int64, Int) -> Float
  private var position: Int64
  private var gate: Gate?
  private var gateAfter: Int64 = .max

  init(seconds: Double, from firstFrame: Int64 = 0, signal: @escaping @Sendable (Int64, Int) -> Float) {
    total = EngineFormat.frames(seconds)
    position = firstFrame
    self.signal = signal
  }

  /// After `frames`, every read waits for the gate to open once (a slow network).
  func stall(after frames: Int64, until gate: Gate) {
    gateAfter = frames
    self.gate = gate
  }

  func read(maxFrames: Int) async throws -> PCMBlock? {
    if position >= gateAfter, let gate {
      await gate.wait()
      self.gate = nil
    }
    guard position < total else { return nil }
    let range = position..<min(position + Int64(maxFrames), total)
    position = range.upperBound
    return PCMBlock(left: range.map { signal($0, 0) }, right: range.map { signal($0, 1) })
  }

  func close() {}
}

enum Signals {
  /// A 441 Hz sine at amplitude 0.5: exactly 441 cycles a second, so a song of whole seconds ends at phase 0.
  static let sine: @Sendable (Int64, Int) -> Float = { n, _ in Float(0.5 * sin(2 * .pi * 441 * Double(n) / 44_100)) }
  static func constant(_ left: Float, _ right: Float) -> @Sendable (Int64, Int) -> Float { { _, c in c == 0 ? left : right } }
}

extension AudioEngine {
  /// An offline engine whose songs are synthetic: `signals[track.id]` for `track.duration` seconds.
  static func offline(_ signals: [Int: @Sendable (Int64, Int) -> Float], tuning: Tuning = Tuning()) throws -> AudioEngine {
    try AudioEngine(tuning: tuning, manualRendering: true) { item, firstFrame in
      SignalSource(seconds: item.track.duration, from: firstFrame, signal: signals[item.track.id] ?? Signals.sine)
    }
  }

  /// Lets every read in flight finish and the engine pump, until nothing is being read, or nothing has been decoded
  /// for 50 ms (a stalled source).
  func settle() async {
    var progress = -1
    var still = 0
    while still < 50 {
      pump()
      let all = decks + [transitionDeck]
      if all.allSatisfy({ $0.reading == nil }) { return }
      let now = all.reduce(0) { $0 + Int($1.segment?.decoded ?? 0) }
      still = now == progress ? still + 1 : 0
      progress = now
      try? await Task.sleep(for: .milliseconds(1))
    }
  }

  /// Renders up to `seconds` offline, settling between blocks of 4096 frames (about the Player's 10 Hz tick). Stops
  /// early when the engine stops running (paused, buffering).
  func render(seconds: Double) async throws -> PCMBlock {
    var out = PCMBlock(left: [], right: [])
    var left = Int(EngineFormat.frames(seconds))
    let buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 4096)!
    while left > 0 {
      await settle()
      guard engine.isRunning else { break }
      let n = min(4096, left)
      _ = try engine.renderOffline(AVAudioFrameCount(n), to: buffer)
      let block = PCMBlock(buffer)
      out.left += block.left
      out.right += block.right
      left -= n
    }
    await settle()
    return out
  }
}

/// The limiter's lookahead delays everything by a few milliseconds: the lag (in frames) at which `out` matches
/// `expected`, searched up to 512.
func latency(of out: PCMBlock, matching expected: (Int) -> Float) -> Int {
  (0..<512).min { a, b in
    let ea = (0..<2000).reduce(Float(0)) { $0 + abs(out.left[$1 + a] - expected($1)) }
    let eb = (0..<2000).reduce(Float(0)) { $0 + abs(out.left[$1 + b] - expected($1)) }
    return ea < eb
  } ?? 0
}
