import PlayarrPlayer

/// A song's worth of silence, for the demo and tests: the player runs (time moves, songs end) without a server.
public actor SilentSource: PCMSource {
  private var framesLeft: Int

  /// `seconds` long, from `frame` (44.1 kHz) on.
  public init(seconds: Double, from frame: Int64 = 0) {
    framesLeft = max(0, Int(seconds * 44_100) - Int(frame))
  }

  public func read(maxFrames: Int) async throws -> PCMBlock? {
    guard framesLeft > 0 else { return nil }
    let count = min(maxFrames, framesLeft)
    framesLeft -= count
    let zeros = [Float](repeating: 0, count: count)
    return PCMBlock(left: zeros, right: zeros)
  }

  public func close() async {
    framesLeft = 0
  }
}
