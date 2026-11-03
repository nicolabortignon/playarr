/// A preview playing (Edit mix points → Play from): which song, from where.
public struct Preview: Equatable, Sendable {
  public let recordingId: String
  /// Seconds into the song.
  public let from: Double
}
