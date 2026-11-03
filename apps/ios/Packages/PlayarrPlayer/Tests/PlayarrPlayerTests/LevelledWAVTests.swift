import Foundation
import Testing
@testable import PlayarrPlayer

struct LevelledWAVTests {
  @Test func everyFrameIsAtAKnownByte() {
    #expect(LevelledWAV.byteOffset(ofFrame: 0) == 44)
    #expect(LevelledWAV.byteOffset(ofFrame: 1) == 48)
    #expect(LevelledWAV.byteOffset(ofFrame: 44_100) == 176_444)
    // 90.5 s into a song.
    #expect(LevelledWAV.byteOffset(ofFrame: EngineFormat.frames(90.5)) == 44 + 3_991_050 * 4)
  }

  @Test func itsRateIsTheEnginesSoFramesNeedNoConversion() {
    #expect(LevelledWAV.sampleRate == EngineFormat.sampleRate)
  }

  @Test func itsBytesDecodeToTheSameFramesHoweverTheyAreSplit() {
    let audio = AudioFiles.levelledWAV(frames: 100) { i, c in Float(i) / 200 * (c == 0 ? 1 : -1) }.dropFirst(44)
    var whole = WAVDecoder()
    let all = whole.decode(Data(audio))
    var split = WAVDecoder()
    var pieces = PCMBlock(left: [], right: [])
    for start in stride(from: audio.startIndex, to: audio.endIndex, by: 7) {
      let block = split.decode(Data(audio[start..<min(start + 7, audio.endIndex)]))
      pieces.left += block.left
      pieces.right += block.right
    }
    #expect(all.frames == 100)
    #expect(pieces == all)
    #expect(abs(all.left[50] - 0.25) < 1e-4)
    #expect(abs(all.right[50] + 0.25) < 1e-4)
  }
}
