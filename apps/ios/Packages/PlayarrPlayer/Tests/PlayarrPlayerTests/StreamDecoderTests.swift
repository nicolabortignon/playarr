import AVFoundation
import Testing
@testable import PlayarrPlayer

struct StreamDecoderTests {
  @Test func decodesAFLACAsItsBytesArriveToTheSample() throws {
    let url = try AudioFiles.flac(seconds: 2, rate: 44_100)
    let pcm = try AudioFiles.decodeStreaming(Data(contentsOf: url), container: "flac")
    #expect(pcm.frames == 88_200)
    let sine = AudioFiles.sine(441, rate: 44_100)
    let worst = (0..<pcm.frames).map { abs(pcm.left[$0] - sine($0, 0)) }.max() ?? 1
    #expect(worst < 1e-6)  // 24-bit: the same samples
    #expect(pcm.left == pcm.right)
  }

  @Test func convertsOtherRatesAndWidthsToTheEnginesClock() throws {
    for (rate, bits) in [(48_000.0, 16), (88_200.0, 24), (96_000.0, 24)] {
      let url = try AudioFiles.flac(seconds: 1.5, rate: rate, bits: bits)
      let pcm = try AudioFiles.decodeStreaming(Data(contentsOf: url), container: "flac")
      #expect(pcm.frames == Int((1.5 * 44_100).rounded()), "\(rate) Hz")
    }
  }

  @Test func playsAMonoFileInBothEars() throws {
    let url = try AudioFiles.flac(seconds: 0.5, channels: 1)
    let pcm = try AudioFiles.decodeStreaming(Data(contentsOf: url), container: "flac")
    #expect(pcm.frames == 22_050)
    #expect(pcm.left == pcm.right)
    #expect(pcm.left.contains { $0 != 0 })
  }

  @Test func decodesMP3() throws {
    let pcm = try AudioFiles.decodeStreaming(AudioFiles.silentMP3(frames: 40), container: "mp3")
    #expect(pcm.frames >= 38 * 1152 && pcm.frames <= 40 * 1152)
    #expect(pcm.left.allSatisfy { $0 == 0 })
  }

  @Test func saysWhenItCannotStreamAFormatSoTheCallerFallsBack() throws {
    #expect(StreamDecoder.fileType(forContainer: "ogg") == nil)
    let decoder = try StreamDecoder(fileType: kAudioFileFLACType)
    #expect(throws: StreamDecoder.Failure.self) {
      try decoder.feed(Data(repeating: 0x42, count: 4096))
      try decoder.endOfInput()
    }
  }
}
