import AVFoundation

/// Decodes a song whose file is all on this device (the stream cache's, later a download's): AVAudioFile reads any
/// format the system knows and seeks exactly, and an AVAudioConverter brings it to the engine's format.
final class FileDecoder {
  private let file: AVAudioFile
  private let converter: AVAudioConverter
  private var inputEnded = false

  /// Starts at `firstFrame` (engine frames, 44.1 kHz), converted to the file's rate.
  init(url: URL, firstFrame: Int64 = 0) throws {
    file = try AVAudioFile(forReading: url)
    guard let converter = AVAudioConverter(from: file.processingFormat, to: EngineFormat.av) else {
      throw PlaybackError.unsupported
    }
    self.converter = converter
    let ratio = file.processingFormat.sampleRate / EngineFormat.sampleRate
    file.framePosition = min(file.length, Int64((Double(firstFrame) * ratio).rounded()))
  }

  /// Up to `maxFrames` frames; nil at the end.
  func decode(maxFrames: Int) throws -> PCMBlock? {
    guard let out = AVAudioPCMBuffer(pcmFormat: EngineFormat.av, frameCapacity: AVAudioFrameCount(maxFrames)) else { return nil }
    var error: NSError?
    var readError: (any Error)?
    let status = converter.convert(to: out, error: &error) { [self] wanted, inputStatus in
      let left = file.length - file.framePosition
      guard !inputEnded, left > 0,
        let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: max(wanted, 4096))
      else {
        // AVAudioFile throws rather than reading nothing at its end: stop before it.
        inputEnded = true
        inputStatus.pointee = .endOfStream
        return nil
      }
      do {
        try file.read(into: input, frameCount: AVAudioFrameCount(min(Int64(input.frameCapacity), left)))
      } catch {
        readError = error
        inputStatus.pointee = .endOfStream
        return nil
      }
      inputStatus.pointee = .haveData
      return input
    }
    if status == .error || readError != nil { throw PlaybackError.undecodable }
    if out.frameLength == 0 && status == .endOfStream { return nil }
    return PCMBlock(out)
  }
}
