/// Where a deck gets its audio: a song's own file, its levelled stream, a transition file, or (in tests) a
/// synthetic signal. Reads come in order; each returns the next frames in `EngineFormat`.
public protocol PCMSource: Sendable {
  /// Up to `maxFrames` frames, waiting for the network as needed; nil once the audio has ended.
  func read(maxFrames: Int) async throws -> PCMBlock?
  /// Stop downloading and decoding. Later reads return nil.
  func close() async
}
