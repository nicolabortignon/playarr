import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// A song whose own file is `kbps` (a FLAC at 900 by default): encoded at High and Normal.
func encodable(_ track: Track, kbps: Double = 900) -> Track {
  var track = track
  track.format.bitrate = kbps
  return track
}

struct StreamQualityTests {
  @Test func encodesOnlyFilesWellAboveTheBitrateAsked() {
    let flac = encodable(song(1))
    #expect(!StreamQuality.original.encodes(flac))
    #expect(StreamQuality.high.encodes(flac))
    #expect(StreamQuality.normal.encodes(flac))
    // An MP3 at 128 kbps plays as it is at Normal; at 320 it's encoded at Normal, not at High (within a quarter).
    let small = encodable(song(2, container: "mp3"), kbps: 128)
    #expect(!StreamQuality.normal.encodes(small))
    let large = encodable(song(3, container: "mp3"), kbps: 320)
    #expect(StreamQuality.normal.encodes(large))
    #expect(!StreamQuality.high.encodes(large))
    #expect(StreamQuality.high.of(large) == .original)
    #expect(StreamQuality.normal.of(large) == .normal)
  }

  @Test func readsTheBitrateFromTheSizeWhenTheFormatDoesntSay() {
    var track = song(1, duration: 100)
    track.size = 10_000_000  // 800 kbps
    #expect(StreamQuality.fileKbps(track) == 800)
    #expect(StreamQuality.normal.encodes(track))
  }

  @Test func neverEncodesASongNotStreamedFromStream() {
    var track = encodable(song(1))
    track.streamUrl = "/transitions/abc.rest.flac"
    #expect(!StreamQuality.normal.encodes(track))
  }

  @Test func encodesAtLowFilesWellAbove64Kbps() {
    #expect(StreamQuality.low.kbps == 64)
    #expect(StreamQuality.low.encodes(encodable(song(1), kbps: 128)))
    #expect(!StreamQuality.low.encodes(encodable(song(2, container: "mp3"), kbps: 80)))
    #expect(StreamQuality.low.bitrate(of: encodable(song(1))) == 64)
    #expect(StreamQuality.original.bitrate(of: encodable(song(1))) == 900)
  }

  @Test func ranksBetterCopiesAsDoing() {
    #expect(StreamQuality.normal.atLeast(.low))
    #expect(!StreamQuality.low.atLeast(.normal))
    #expect(StreamQuality.original.atLeast(.normal))
    #expect(StreamQuality.high.atLeast(.normal))
    #expect(StreamQuality.high.atLeast(.high))
    #expect(!StreamQuality.normal.atLeast(.high))
    #expect(!StreamQuality.high.atLeast(.original))
  }

  @Test func sizesAnEncodedSongAtMostWhatItsStreamDeclares() {
    let track = encodable(song(1, duration: 200))
    #expect(StreamQuality.normal.size(of: track) == 3_840_000 + 16_384)  // 200 s × 16 KB/s × 1.2
    #expect(StreamQuality.original.size(of: track) == 1_000_000)
  }

  @Test func remembersSongsWithoutAnEncodedStreamAndAServerWithoutAny() {
    let support = EncodeSupport()
    support.failed(1, status: 404, message: "This source can’t encode songs")
    #expect(!support.allows(1))
    #expect(support.allows(2))
    // Busy is only busy now.
    support.failed(3, status: 503, message: "Too many songs are being encoded")
    #expect(support.allows(3))
    // A server from before encoded streams: its own 404 for a path it doesn't have.
    support.failed(4, status: 404, message: "Not found")
    #expect(!support.allows(2))
  }
}

struct StreamPaddingTests {
  static let fixture = Bundle.module.url(forResource: "Fixtures/encoded-click", withExtension: "mp4")!
  /// Where the fixture's audio ends and its `free` box starts.
  static let audioBytes: Int64 = 41_600

  @Test(arguments: [1, 7, 8, 9, 1000, 65_536, 1 << 20])
  func findsWhereTheAudioEndsHoweverTheBytesArrive(chunk: Int) throws {
    let data = try Data(contentsOf: Self.fixture)
    var padding = StreamPadding()
    var offset = 0
    while offset < data.count, padding.start == nil {
      padding.scan(data.subdata(in: offset..<min(offset + chunk, data.count)))
      offset += chunk
    }
    #expect(padding.start == Self.audioBytes)
  }

  @Test func cutsAWholeStreamAtItsPaddingAndLeavesOtherFilesAlone() throws {
    let url = temporaryDirectory().appending(path: "12.normal.m4a")
    try FileManager.default.copyItem(at: Self.fixture, to: url)
    #expect(StreamPadding.trim(url) == Self.audioBytes)
    #expect(try Data(contentsOf: url).count == Int(Self.audioBytes))
    // Cut, it still plays to the sample.
    let decoder = try FileDecoder(url: url)
    var frames = 0
    while let block = try decoder.decode(maxFrames: 8192) { frames += block.frames }
    #expect(frames == 132_300)
    #expect(StreamPadding.trim(url) == Self.audioBytes)

    let flac = try AudioFiles.flac(seconds: 1)
    let size = try Data(contentsOf: flac).count
    #expect(StreamPadding.trim(flac) == Int64(size))
  }
}
