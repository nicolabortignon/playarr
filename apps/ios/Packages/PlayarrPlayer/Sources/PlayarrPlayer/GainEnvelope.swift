import Foundation

/// Equal-power fade: `x` from 0 (silent) to 1 (full). As `fadeCurve` in apps/web/src/player/decks.ts.
public func fadeCurve(_ x: Double) -> Double { sin(min(1, max(0, x)) * .pi / 2) }

/// A stretch of the timeline over which a fade runs.
public struct Ramp: Sendable, Equatable {
  public var start: SampleTime
  public var frames: Int64
  public init(start: SampleTime, frames: Int64) {
    self.start = start
    self.frames = frames
  }
  public var end: SampleTime { start + frames }
}

/// How loud a deck plays each sample: its song's level (up as well as down), times a fade in at its start and a
/// fade out at its end. Applied to the PCM before it is scheduled, so fades and gains are exact to the sample
/// (a mixer's volume isn't) and gains above 0 dB work.
public struct GainEnvelope: Sendable, Equatable {
  public var gain: Float
  /// Rising from silence to full over the ramp; silent before it.
  public var fadeIn: Ramp?
  /// Falling from full to silence over the ramp; silent after it. A ramp of 0 frames is a cut.
  public var fadeOut: Ramp?

  public init(gainDb: Double = 0, fadeIn: Ramp? = nil, fadeOut: Ramp? = nil) {
    gain = Float(pow(10, gainDb / 20))
    self.fadeIn = fadeIn
    self.fadeOut = fadeOut
  }

  public func value(at t: SampleTime) -> Float {
    var v = Double(gain)
    if let r = fadeIn, t < r.end {
      v *= r.frames > 0 ? fadeCurve(Double(t - r.start) / Double(r.frames)) : 1
    }
    if let r = fadeOut, t >= r.start {
      v *= r.frames > 0 ? fadeCurve(Double(r.end - t) / Double(r.frames)) : 0
    }
    return Float(v)
  }

  /// Scales `block`, whose first frame plays at timeline sample `start`.
  public func apply(to block: inout PCMBlock, at start: SampleTime) {
    let end = start + Int64(block.frames)
    let fading = (fadeIn.map { start < $0.end } ?? false) || (fadeOut.map { end > $0.start } ?? false)
    guard fading else { return block.scale(by: gain) }
    block.scale(by: (0..<block.frames).map { value(at: start + Int64($0)) })
  }
}
