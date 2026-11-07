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

  /// The server's encoded stream (plan 2 §1): Apple's AAC in the server's fragmented MP4, decoded as it arrives and
  /// trimmed by the packet table its iTunSMPB gives. Every sample where the song has it: the song's length exactly,
  /// the same samples as AVAudioFile gives (Core Audio's ExtAudioFile, which the server's alignment test measured
  /// exact), each click on its sample.
  @Test func decodesAnEncodedStreamAsItArrivesToTheSample() throws {
    let data = try Data(contentsOf: StreamPaddingTests.fixture)
    let streamed = try AudioFiles.decodeStreaming(data, container: "m4a", chunk: 1_000)
    #expect(streamed.frames == 132_300)
    let decoder = try FileDecoder(url: StreamPaddingTests.fixture)
    var file = PCMBlock(left: [], right: [])
    while let block = try decoder.decode(maxFrames: 8192) {
      file.left += block.left
      file.right += block.right
    }
    #expect(file.frames == streamed.frames)
    let worst = zip(file.left, streamed.left).map { abs($0 - $1) }.max() ?? 1
    #expect(worst < 1e-5)
    // The clicks (0.9 over noise at 0.1), each the loudest sample around its place.
    for mark in [10_000, 30_011, 50_022, 70_033, 90_044, 110_055] {
      let around = (mark - 500)...(mark + 500)
      let loudest = around.max { abs(streamed.left[$0]) < abs(streamed.left[$1]) }!
      #expect(abs(loudest - mark) <= 1, "click at \(mark) heard at \(loudest)")
    }
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
