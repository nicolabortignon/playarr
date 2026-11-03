import AVFoundation

/// A position on the engine's sample clock: frames at `EngineFormat.sampleRate` since the current epoch began
/// (the last time the decks were started together, see `AudioEngine`).
public typealias SampleTime = Int64

/// The one format every deck plays: 44.1 kHz stereo Float32, non-interleaved. Songs at other rates and widths
/// are converted as they're decoded, so all decks share one sample clock. 44.1 kHz because most music is at that
/// rate and so are the server's levelled streams (`LOUDNESS_RATE`), so a seek into one needs no conversion. The
/// main mixer converts to the hardware's rate (often 48 kHz) on the way out.
public enum EngineFormat {
  public static let sampleRate: Double = 44_100
  public static let channelCount: AVAudioChannelCount = 2
  public static let av: AVAudioFormat = {
    guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: channelCount) else {
      preconditionFailure("44.1 kHz stereo float is always a valid format")
    }
    return format
  }()

  public static func frames(_ seconds: Double) -> Int64 { Int64((seconds * sampleRate).rounded()) }
  public static func seconds(_ frames: Int64) -> Double { Double(frames) / sampleRate }
}
