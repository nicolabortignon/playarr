import Foundation
import PlayarrAPI

/// B played at the plan's rate for a mix the engine plays itself, the way a DJ's pitch fader does it: resampled, so
/// its tempo meets A's (and its pitch moves with it, by at most 2%: the planner stretches a quick mix no further).
/// Then B goes on at its own speed. The rate is followed exactly: output sample n is B's frame
/// `bResume·44 100 − 44 100·∫ rate` from n to the transition's end, so after `lengthFrames` it reads B's own frames,
/// sample for sample, from `round(bResume × 44 100)`, as the rest of the song does.
///
/// AVAudioUnitTimePitch keeps pitch, but it delays its output by a varying amount and takes rate changes from the main
/// thread between render cycles: B would leave the shared timeline and miss its landing. A cubic resampler over the
/// PCM is exact, runs on the source's actor, and the 2% pitch moves for a few beats while B fades in.
actor VarispeedSource: PCMSource {
  private let base: any PCMSource
  private let rate: Automation
  private let lengthFrames: Int64
  /// B's frame (fractional) that output sample `produced` reads.
  private var position: Double
  /// B's frames read so far from `base`: `buffer` holds frames `bufferStart..<bufferStart + buffer.frames`.
  private var buffer = PCMBlock(left: [], right: [])
  private var bufferStart: Int64
  private var produced: Int64 = 0
  private var ended = false

  /// The frame `base` starts at, to read from one frame before where the transition starts reading B.
  static func baseStart(plan: TransitionPlan, lengthFrames: Int64, endFrame: Int64) -> Int64 {
    max(0, Int64(startPosition(plan: plan, lengthFrames: lengthFrames, endFrame: endFrame).rounded(.down)) - 1)
  }

  static func startPosition(plan: TransitionPlan, lengthFrames: Int64, endFrame: Int64) -> Double {
    Double(endFrame) - EngineFormat.sampleRate * plan.bRate.integral(from: 0, to: Double(lengthFrames) / EngineFormat.sampleRate)
  }

  /// `base` reads B from `baseStart`; the transition lasts `lengthFrames` and runs into B's frame `endFrame`.
  init(base: any PCMSource, baseStart: Int64, rate: Automation, lengthFrames: Int64, endFrame: Int64, plan: TransitionPlan) {
    self.base = base
    self.rate = rate
    self.lengthFrames = lengthFrames
    bufferStart = baseStart
    position = Self.startPosition(plan: plan, lengthFrames: lengthFrames, endFrame: endFrame)
  }

  func read(maxFrames: Int) async throws -> PCMBlock? {
    if produced >= lengthFrames {
      // B's own frames from here: what's left of the buffer, then the base as it comes.
      let from = Int(Int64(position.rounded()) - bufferStart)
      if from < buffer.frames {
        let out = buffer.slice(max(0, from)..<min(buffer.frames, max(0, from) + maxFrames))
        position += Double(out.frames)
        produced += Int64(out.frames)
        return out
      }
      return try await base.read(maxFrames: maxFrames)
    }
    let count = Int(min(Int64(maxFrames), lengthFrames - produced))
    // Enough of B for this block: up to two frames past the furthest position it reads.
    let furthest = position + Double(count) * max(1, rate.map(\.value).max() ?? 1) + 3
    while !ended, Double(bufferStart) + Double(buffer.frames) < furthest {
      guard let more = try await base.read(maxFrames: 22_050) else {
        ended = true
        break
      }
      buffer.left += more.left
      buffer.right += more.right
    }
    var left = [Float](repeating: 0, count: count), right = [Float](repeating: 0, count: count)
    for i in 0..<count {
      let p = position - Double(bufferStart)
      left[i] = Self.cubic(buffer.left, p)
      right[i] = Self.cubic(buffer.right, p)
      position += rate.value(at: (Double(produced + Int64(i)) + 0.5) / EngineFormat.sampleRate)
    }
    produced += Int64(count)
    if produced == lengthFrames {
      // The transition's end: exactly B's frame where its own playback picks up.
      position = position.rounded()
    }
    // Keep a few frames behind the read position (the interpolation looks one back).
    let keepFrom = Int(position.rounded(.down)) - Int(bufferStart) - 2
    if keepFrom > 0 {
      let drop = min(keepFrom, buffer.frames)
      buffer = buffer.dropping(drop)
      bufferStart += Int64(drop)
    }
    return PCMBlock(left: left, right: right)
  }

  func close() async { await base.close() }

  /// Catmull-Rom between samples ⌊p⌋ and ⌊p⌋+1; silence outside what's there.
  static func cubic(_ s: [Float], _ p: Double) -> Float {
    let i = Int(p.rounded(.down))
    let t = Float(p - Double(i))
    func at(_ k: Int) -> Float { s.indices.contains(k) ? s[k] : 0 }
    let (y0, y1, y2, y3) = (at(i - 1), at(i), at(i + 1), at(i + 2))
    if t == 0 { return y1 }
    let a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3
    let b = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
    let c = -0.5 * y0 + 0.5 * y2
    return ((a * t + b) * t + c) * t + y1
  }
}
