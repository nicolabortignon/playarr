import Foundation

/// Turns the bytes of a levelled stream's audio (16-bit little-endian stereo at 44.1 kHz, see `LevelledWAV`) into
/// engine frames. Bytes arrive in any split: an incomplete frame waits for the next chunk.
struct WAVDecoder {
  private var carry = Data()

  mutating func decode(_ data: Data) -> PCMBlock {
    let bytes = carry + data
    let frames = bytes.count / Int(LevelledWAV.bytesPerFrame)
    carry = bytes.suffix(from: bytes.startIndex + frames * Int(LevelledWAV.bytesPerFrame))
    var left = [Float](repeating: 0, count: frames)
    var right = [Float](repeating: 0, count: frames)
    bytes.withUnsafeBytes { raw in
      for i in 0..<frames {
        left[i] = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 4, as: Int16.self))) / 32_768
        right[i] = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 4 + 2, as: Int16.self))) / 32_768
      }
    }
    return PCMBlock(left: left, right: right)
  }
}
