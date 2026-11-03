import AVFoundation
import Foundation
@testable import PlayarrPlayer

/// Test files made on the spot with the system's encoders, so no binary fixtures live in the repo.
enum AudioFiles {
  /// A sine at `hertz` (amplitude 0.5) that starts at phase 0; `frame` is the index at the file's rate.
  static func sine(_ hertz: Double, rate: Double) -> (Int, Int) -> Float {
    { frame, _ in Float(0.5 * sin(2 * .pi * hertz * Double(frame) / rate)) }
  }

  /// Writes a FLAC file. (Apple's encoder writes nothing for less than one block, so keep files ≥ 0.2 s.)
  static func flac(
    seconds: Double, rate: Double = 44_100, channels: AVAudioChannelCount = 2, bits: Int = 24,
    signal: ((Int, Int) -> Float)? = nil
  ) throws -> URL {
    let url = temporaryDirectory().appending(path: "test.flac")
    let frames = Int(seconds * rate)
    let signal = signal ?? sine(441, rate: rate)
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: channels, interleaved: false)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
    buffer.frameLength = AVAudioFrameCount(frames)
    for c in 0..<Int(channels) {
      for i in 0..<frames { buffer.floatChannelData![c][i] = signal(i, c) }
    }
    do {
      let file = try AVAudioFile(
        forWriting: url,
        settings: [AVFormatIDKey: kAudioFormatFLAC, AVSampleRateKey: rate, AVNumberOfChannelsKey: channels, AVLinearPCMBitDepthKey: bits],
        commonFormat: .pcmFormatFloat32, interleaved: false)
      try file.write(from: buffer)
    }  // closing the file flushes its last block
    return url
  }

  /// MPEG-1 Layer III frames of silence (128 kb/s, 44.1 kHz, stereo, 417 bytes each): a header and zeroed side
  /// information and main data, which decoders read as 1152 frames of silence.
  static func silentMP3(frames: Int) -> Data {
    var frame = Data([0xFF, 0xFB, 0x90, 0x04])
    frame.append(Data(count: 417 - 4))
    return Data((0..<frames).flatMap { _ in frame })
  }

  /// A levelled stream as the server makes it (apps/server/src/media/levelled.ts): a 44-byte header, then 16-bit
  /// stereo frames at 44.1 kHz.
  static func levelledWAV(frames: Int, signal: (Int, Int) -> Float) -> Data {
    var data = Data(count: 44)
    for i in 0..<frames {
      for c in 0..<2 {
        let v = Int16(max(-32_768, min(32_767, (signal(i, c) * 32_768).rounded())))
        withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) }
      }
    }
    return data
  }

  /// Every frame of `data`, decoded by a StreamDecoder fed `chunk` bytes at a time.
  static func decodeStreaming(_ data: Data, container: String, chunk: Int = 997, maxFrames: Int = 4096) throws -> PCMBlock {
    let decoder = try StreamDecoder(fileType: StreamDecoder.fileType(forContainer: container)!)
    var out = PCMBlock(left: [], right: [])
    var offset = 0
    while true {
      guard let block = try decoder.decode(maxFrames: maxFrames) else { return out }
      if block.frames > 0 {
        out.left += block.left
        out.right += block.right
        continue
      }
      if offset < data.count {
        let end = min(offset + chunk, data.count)
        try decoder.feed(data.subdata(in: offset..<end))
        offset = end
      } else {
        try decoder.endOfInput()
      }
    }
  }
}
