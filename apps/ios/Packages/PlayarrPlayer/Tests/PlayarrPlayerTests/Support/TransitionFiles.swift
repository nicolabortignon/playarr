import AVFoundation
import Foundation
import PlayarrAPI
@testable import PlayarrPlayer

/// Synthetic transitions for the engine's tests.
enum TransitionFiles {
  /// A 24-bit FLAC of exactly `frames` frames at 44.1 kHz: `signal(frame, channel)`.
  static func flac(frames: Int, signal: (Int, Int) -> Float) throws -> URL {
    let url = temporaryDirectory().appending(path: "transition.flac")
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44_100, channels: 2, interleaved: false)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
    buffer.frameLength = AVAudioFrameCount(frames)
    for c in 0..<2 {
      for i in 0..<frames { buffer.floatChannelData![c][i] = signal(i, c) }
    }
    do {
      let file = try AVAudioFile(
        forWriting: url, settings: [AVFormatIDKey: kAudioFormatFLAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 2, AVLinearPCMBitDepthKey: 24],
        commonFormat: .pcmFormatFloat32, interleaved: false)
      try file.write(from: buffer)
    }
    return url
  }

  /// Not periodic over a few samples, so a changeover a sample early or late shows as a step: two sines whose
  /// frequencies share no period.
  static let music: @Sendable (Int64) -> Float = { n in
    let t = Double(n) / 44_100
    return Float(0.3 * sin(2 * .pi * 523.25 * t) + 0.1 * sin(2 * .pi * 61.7 * t))
  }

  static func plan(
    style: TransitionStyle = .long, aStart: Double, bStart: Double = 8, length: Double, bResume: Double, switchAt: Double,
    bRate: Automation = [.init(at: 0, value: 1)], aGain: Automation? = nil, bGain: Automation? = nil
  ) -> TransitionPlan {
    TransitionPlan(
      style: style, aStart: aStart, bStart: bStart, length: length, bResume: bResume, switchAt: switchAt, bRate: bRate,
      aGain: aGain ?? [.init(at: 0, value: 1), .init(at: length, value: 0)], bGain: bGain ?? [.init(at: 0, value: 0), .init(at: length, value: 1)],
      aLowDb: [.init(at: 0, value: 0)], bLowDb: [.init(at: 0, value: 0)], aHighPassHz: [.init(at: 0, value: 20)], reason: "test", beats: 0)
  }
}

extension AudioEngine.Tuning {
  /// As the Player sets it for DJ mix.
  static var dj: AudioEngine.Tuning {
    var tuning = AudioEngine.Tuning()
    tuning.scheduleAhead = 2.5
    return tuning
  }
}
