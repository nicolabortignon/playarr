/// The server's levelled stream (`/stream/:fileId/levelled.wav?gain=`, apps/server/src/media/levelled.ts): 16-bit
/// stereo PCM at 44.1 kHz behind a 44-byte header, every byte at a known place. A range from any byte is decoded by
/// the server from that very sample, so a seek into it is exact.
public enum LevelledWAV {
  public static let headerBytes: Int64 = 44
  public static let bytesPerFrame: Int64 = 4
  public static let sampleRate: Double = 44_100

  /// The byte where frame `frame` (at 44.1 kHz) starts.
  public static func byteOffset(ofFrame frame: Int64) -> Int64 { headerBytes + frame * bytesPerFrame }
}
