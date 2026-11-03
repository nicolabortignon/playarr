import AVFoundation
import Testing
@testable import PlayarrPlayer

struct PCMBlockTests {
  @Test func goesToAnEngineBufferAndBack() throws {
    let block = PCMBlock(left: [0.1, 0.2, 0.3], right: [-0.1, -0.2, -0.3])
    let buffer = try #require(block.makeBuffer())
    #expect(buffer.format == EngineFormat.av)
    #expect(buffer.frameLength == 3)
    #expect(PCMBlock(buffer) == block)
  }

  @Test func slicesAndDrops() {
    let block = PCMBlock(left: [1, 2, 3, 4], right: [5, 6, 7, 8])
    #expect(block.slice(1..<3) == PCMBlock(left: [2, 3], right: [6, 7]))
    #expect(block.dropping(3) == PCMBlock(left: [4], right: [8]))
    #expect(block.dropping(9).frames == 0)
  }
}
