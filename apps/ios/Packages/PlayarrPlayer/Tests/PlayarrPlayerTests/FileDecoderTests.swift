import Foundation
import Testing
@testable import PlayarrPlayer

struct FileDecoderTests {
  @Test func decodesAWholeFileFromAnExactFrame() throws {
    let url = try AudioFiles.flac(seconds: 1, rate: 48_000)
    let decoder = try FileDecoder(url: url, firstFrame: 0)
    var frames = 0
    while let block = try decoder.decode(maxFrames: 4096) { frames += block.frames }
    #expect(frames == 44_100)
    let sine = AudioFiles.sine(441, rate: 44_100)
    let late = try FileDecoder(url: try AudioFiles.flac(seconds: 1), firstFrame: 20_000)
    let first = try #require(try late.decode(maxFrames: 16))
    #expect(abs(first.left[0] - sine(20_000, 0)) < 1e-6)
  }
}
