import AVFoundation
import Accelerate

/// Decoded audio in the engine's format, as plain arrays: a value that crosses from a decoder's actor to the
/// engine on the main actor without sharing memory (`AVAudioPCMBuffer` isn't `Sendable`).
public struct PCMBlock: Sendable, Equatable {
  public var left: [Float]
  public var right: [Float]

  public init(left: [Float], right: [Float]) {
    precondition(left.count == right.count, "both channels hold the same number of frames")
    self.left = left
    self.right = right
  }

  public static func silence(frames: Int) -> PCMBlock {
    PCMBlock(left: [Float](repeating: 0, count: frames), right: [Float](repeating: 0, count: frames))
  }

  public var frames: Int { left.count }

  /// Frames `range` of this block.
  public func slice(_ range: Range<Int>) -> PCMBlock {
    PCMBlock(left: Array(left[range]), right: Array(right[range]))
  }

  /// The frames after the first `count`.
  public func dropping(_ count: Int) -> PCMBlock { slice(min(count, frames)..<frames) }

  public mutating func scale(by gain: Float) {
    guard gain != 1 else { return }
    left = vDSP.multiply(gain, left)
    right = vDSP.multiply(gain, right)
  }

  /// Multiplies frame `i` by `gains[i]`.
  public mutating func scale(by gains: [Float]) {
    precondition(gains.count == frames)
    left = vDSP.multiply(left, gains)
    right = vDSP.multiply(right, gains)
  }

  /// A copy of an engine-format buffer (a mono buffer is heard in both ears).
  public init(_ buffer: AVAudioPCMBuffer) {
    let n = Int(buffer.frameLength)
    guard let data = buffer.floatChannelData, n > 0 else {
      self.init(left: [], right: [])
      return
    }
    let l = Array(UnsafeBufferPointer(start: data[0], count: n))
    let r = buffer.format.channelCount > 1 ? Array(UnsafeBufferPointer(start: data[1], count: n)) : l
    self.init(left: l, right: r)
  }

  /// An engine-format buffer holding these frames, for a player node.
  public func makeBuffer() -> AVAudioPCMBuffer? {
    guard frames > 0,
      let buffer = AVAudioPCMBuffer(pcmFormat: EngineFormat.av, frameCapacity: AVAudioFrameCount(frames)),
      let data = buffer.floatChannelData
    else { return nil }
    buffer.frameLength = AVAudioFrameCount(frames)
    for (channel, samples) in [left, right].enumerated() {
      samples.withUnsafeBufferPointer { source in
        if let base = source.baseAddress { data[channel].update(from: base, count: frames) }
      }
    }
    return buffer
  }
}
