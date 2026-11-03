import Foundation

/// The part of a downloaded transition file the engine plays: frames `from..<to` (from the changeover in its lead to
/// the end of the transition, where B's own playback takes over), turned by the correction for levels it wasn't made
/// at (see `TransitionJoin`).
actor TransitionFileSource: PCMSource {
  private let url: URL
  private let join: TransitionJoin
  private var position: Int64
  private let to: Int64
  private var decoder: FileDecoder?
  private var closed = false

  init(_ join: TransitionJoin, from: Int64, to: Int64) {
    url = join.file
    self.join = join
    position = from
    self.to = to
  }

  func read(maxFrames: Int) async throws -> PCMBlock? {
    guard !closed, position < to else { return nil }
    if decoder == nil { decoder = try FileDecoder(url: url, firstFrame: position) }
    guard let decoder, let decoded = try decoder.decode(maxFrames: Int(min(Int64(maxFrames), to - position))) else { return nil }
    var block = decoded.frames > Int(to - position) ? decoded.slice(0..<Int(to - position)) : decoded
    if join.correctionA != 0 || join.correctionB != 0 {
      let gainA = pow(10, join.correctionA / 20), gainB = pow(10, join.correctionB / 20)
      let first = position - join.leadFrames
      block.scale(by: (0..<block.frames).map {
        Float(MixSequence.bridgeGain(join.plan, Double(first + Int64($0)) / EngineFormat.sampleRate, gainA: gainA, gainB: gainB))
      })
    }
    position += Int64(block.frames)
    return block
  }

  func close() async { closed = true }
}
