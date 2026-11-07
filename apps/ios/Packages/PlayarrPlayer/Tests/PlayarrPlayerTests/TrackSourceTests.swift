import Foundation
import Testing
@testable import PlayarrPlayer

@Suite(.serialized)
struct TrackSourceTests {
  let sine = AudioFiles.sine(441, rate: 44_100)

  func source(_ id: Int, container: String = "flac", from frame: Int64 = 0, levelled: Bool = false, cache: StreamCache? = nil) -> (TrackSource, StreamCache) {
    let cache = cache ?? StreamCache(directory: temporaryDirectory(), retryDelay: .milliseconds(5), configuration: StubServer.configuration)
    let origin = TrackSource.Origin(
      stream: StubServer.request("/stream/\(id)"),
      levelled: levelled ? StubServer.request("/stream/\(id)/levelled.wav") : nil)
    let session = URLSession(configuration: StubServer.configuration())
    return (TrackSource(track: song(id, container: container), firstFrame: frame, origin: origin, cache: cache, probeSession: session), cache)
  }

  func readAll(_ source: TrackSource) async throws -> PCMBlock {
    var all = PCMBlock(left: [], right: [])
    while let block = try await source.read(maxFrames: 22_050) {
      all.left += block.left
      all.right += block.right
    }
    return all
  }

  @Test func playsAFLACFromTheStartAsItDownloads() async throws {
    StubServer.serve("/stream/101", .init(body: try Data(contentsOf: AudioFiles.flac(seconds: 2)), chunk: 4096))
    let (source, _) = source(101)
    let pcm = try await readAll(source)
    #expect(pcm.frames == 88_200)
    #expect(abs(pcm.left[12_345] - sine(12_345, 0)) < 1e-6)
  }

  @Test func aSeekBeyondTheDownloadPlaysTheLevelledStreamFromThatSample() async throws {
    StubServer.serve("/stream/102", .init(body: try Data(contentsOf: AudioFiles.flac(seconds: 2)), pause: .seconds(5)))
    let ramp: (Int, Int) -> Float = { i, c in Float(i % 1000) / 2000 * (c == 0 ? 1 : -1) }
    StubServer.serve("/stream/102/levelled.wav", .init(body: AudioFiles.levelledWAV(frames: 88_200, signal: ramp)))
    let (source, _) = source(102, from: 44_100, levelled: true)
    let first = try #require(try await source.read(maxFrames: 4096))
    #expect(StubServer.requests("/stream/102/levelled.wav") == ["bytes=176444-"])
    #expect(abs(first.left[0] - ramp(44_100, 0)) < 1e-4)
    #expect(abs(first.right[7] - ramp(44_107, 1)) < 1e-4)
    await source.close()
  }

  @Test func aSeekIntoASongNotMeasuredDecodesFromTheStartAndDropsUpToIt() async throws {
    StubServer.serve("/stream/103", .init(body: try Data(contentsOf: AudioFiles.flac(seconds: 2))))
    let (source, _) = source(103, from: 30_000)
    let pcm = try await readAll(source)
    #expect(pcm.frames == 88_200 - 30_000)
    #expect(abs(pcm.left[0] - sine(30_000, 0)) < 1e-6)
  }

  @Test func aSongAlreadyInTheCachePlaysFromDiskWithAnExactSeek() async throws {
    StubServer.serve("/stream/104", .init(body: try Data(contentsOf: AudioFiles.flac(seconds: 2))))
    let (first, cache) = source(104)
    _ = try await readAll(first)
    try await Task.sleep(for: .milliseconds(50))  // the download's last callback renames the file
    let asked = StubServer.requests("/stream/104").count
    let (again, _) = source(104, from: 10_000, cache: cache)
    let pcm = try await readAll(again)
    #expect(StubServer.requests("/stream/104").count == asked)
    #expect(pcm.frames == 78_200)
    #expect(abs(pcm.left[0] - sine(10_000, 0)) < 1e-6)
  }

  @Test func aKeptSongPlaysWithTheServerOutOfReach() async throws {
    StubServer.serve("/stream/110", .init(body: Data(), unreachable: true))
    let directory = temporaryDirectory()
    try Data(contentsOf: AudioFiles.flac(seconds: 2)).write(to: directory.appending(path: "110.flac"))  // downloaded earlier
    let cache = StreamCache(directory: directory, retryDelay: .milliseconds(5), configuration: StubServer.configuration)
    let (kept, _) = source(110, from: 44_100, levelled: true, cache: cache)
    let pcm = try await readAll(kept)
    #expect(pcm.frames == 44_100)
    #expect(abs(pcm.left[0] - sine(44_100, 0)) < 1e-6)
    #expect(StubServer.requests("/stream/110").isEmpty)
    #expect(StubServer.requests("/stream/110/levelled.wav").isEmpty)
  }

  @Test func aContinuationKeptWithADownloadPlaysFromItsFile() async throws {
    StubServer.serve("/stream/111", .init(body: Data(), unreachable: true))
    let kept = temporaryDirectory().appending(path: "4-5.rest.flac")
    try Data(contentsOf: AudioFiles.flac(seconds: 2)).write(to: kept)
    let cache = StreamCache(directory: temporaryDirectory(), retryDelay: .milliseconds(5), configuration: StubServer.configuration)
    let origin = TrackSource.Origin(stream: StubServer.request("/stream/111"), levelled: nil, kept: kept)
    let source = TrackSource(track: song(111), firstFrame: 44_100, origin: origin, cache: cache)
    let pcm = try await readAll(source)
    #expect(pcm.frames == 44_100)
    #expect(abs(pcm.left[0] - sine(44_100, 0)) < 1e-6)
    #expect(StubServer.requests("/stream/111").isEmpty)
  }

  @Test func aFormatItCannotStreamPlaysFromTheLevelledStream() async throws {
    StubServer.serve("/stream/105", .init(body: Data(repeating: 1, count: 1000)))
    StubServer.serve("/stream/105/levelled.wav", .init(body: AudioFiles.levelledWAV(frames: 1000, signal: { _, _ in 0.25 })))
    let (source, _) = source(105, container: "ogg", levelled: true)
    let pcm = try await readAll(source)
    #expect(pcm.frames == 1000)
    #expect(pcm.left[500] == 0.25)
  }

  // MARK: Encoded streams (plan 2 §1)

  /// A source for song `id` (a FLAC at 900 kbps) wanting its encoded stream at Normal.
  func encodedSource(_ id: Int, from frame: Int64 = 0, support: EncodeSupport = EncodeSupport(), cache: StreamCache? = nil) -> (TrackSource, StreamCache) {
    let cache = cache ?? StreamCache(directory: temporaryDirectory(), retryDelay: .milliseconds(5), configuration: StubServer.configuration)
    let encoded = TrackSource.Encoded(quality: .normal, support: support) { start in
      StubServer.request("/stream/\(id)/aac", query: "kbps=128" + (start > 0 ? "&start=\(start)" : ""))
    }
    let origin = TrackSource.Origin(stream: StubServer.request("/stream/\(id)"), levelled: nil, accepts: .normal, encoded: encoded)
    let session = URLSession(configuration: StubServer.configuration())
    return (TrackSource(track: encodable(song(id)), firstFrame: frame, origin: origin, cache: cache, probeSession: session), cache)
  }

  @Test func playsTheEncodedStreamAndKeepsItWithoutItsPadding() async throws {
    StubServer.serve("/stream/120/aac", .init(body: try Data(contentsOf: StreamPaddingTests.fixture), chunk: 4096))
    let (source, cache) = encodedSource(120)
    let pcm = try await readAll(source)
    #expect(pcm.frames == 132_300)
    #expect(StubServer.requests("/stream/120").isEmpty)
    #expect(StubServer.queries("/stream/120/aac") == ["kbps=128"])
    try await Task.sleep(for: .milliseconds(50))  // the download's last callback renames the file
    let kept = try #require(await cache.completedFile(for: encodable(song(120)), atLeast: .normal))
    #expect(kept.lastPathComponent == "120.normal.m4a")
    #expect(try Data(contentsOf: kept).count == Int(StreamPaddingTests.audioBytes))
    // Its own file is wanted at Original: the copy at Normal won't do there.
    #expect(await cache.completedFile(for: encodable(song(120))) == nil)
  }

  @Test func aSeekAsksForTheEncodedStreamFromThatSampleIntoAFileOfItsOwn() async throws {
    StubServer.serve("/stream/121/aac", .init(body: try Data(contentsOf: StreamPaddingTests.fixture)))
    let (source, cache) = encodedSource(121, from: 44_100)
    let first = try #require(try await source.read(maxFrames: 4096))
    #expect(first.frames > 0)
    #expect(StubServer.queries("/stream/121/aac") == ["kbps=128&start=44100"])
    await source.close()
    // Nothing of it stays: a stream from a sample isn't the song's.
    let names = try FileManager.default.contentsOfDirectory(atPath: await cache.directory.path(percentEncoded: false))
    #expect(!names.contains { $0.hasPrefix("encoded-") || $0.hasPrefix("121.") })
  }

  @Test func aCopyOnTheDeviceAsGoodAsWantedPlaysInsteadOfTheStream() async throws {
    let directory = temporaryDirectory()
    try Data(contentsOf: AudioFiles.flac(seconds: 2)).write(to: directory.appending(path: "122.flac"))
    let cache = StreamCache(directory: directory, retryDelay: .milliseconds(5), configuration: StubServer.configuration)
    let (source, _) = encodedSource(122, cache: cache)
    let pcm = try await readAll(source)
    #expect(pcm.frames == 88_200)
    #expect(StubServer.requests("/stream/122/aac").isEmpty)
  }

  @Test func aServerWithoutEncodedStreamsPlaysTheSongsOwnFileAndIsntAskedAgain() async throws {
    // A server from before encoded streams: its "Not found" for a path it doesn't have.
    StubServer.serve("/stream/123/aac", .init(body: Data(#"{"error":"Not found"}"#.utf8), status: 404))
    StubServer.serve("/stream/123", .init(body: try Data(contentsOf: AudioFiles.flac(seconds: 2))))
    let support = EncodeSupport()
    let (source, _) = encodedSource(123, support: support)
    let pcm = try await readAll(source)
    #expect(pcm.frames == 88_200)
    #expect(!support.allows(123))
    #expect(!support.allows(999))
  }

  @Test func aBusyServerPlaysTheSongsOwnFileThisTimeOnly() async throws {
    StubServer.serve("/stream/124/aac", .init(body: Data(#"{"error":"Too many songs are being encoded"}"#.utf8), status: 503))
    StubServer.serve("/stream/124", .init(body: try Data(contentsOf: AudioFiles.flac(seconds: 2))))
    let support = EncodeSupport()
    let (source, _) = encodedSource(124, support: support)
    let pcm = try await readAll(source)
    #expect(pcm.frames == 88_200)
    #expect(support.allows(124))
  }

  @Test func anEncodeThatFailsMidwayGivesWayToTheSongsOwnFileFromWhereItGot() async throws {
    // The stream breaks off after its first fragment and the server then says the encode failed.
    let stream = try Data(contentsOf: StreamPaddingTests.fixture)
    StubServer.serve("/stream/125/aac", .init(body: stream, chunk: 2048, pause: .milliseconds(20), breakAfter: 12_198, breaks: 1))
    StubServer.serve("/stream/125", .init(body: try Data(contentsOf: AudioFiles.flac(seconds: 4))))
    let support = EncodeSupport()
    let (source, _) = encodedSource(125, support: support)
    var all = PCMBlock(left: [], right: [])
    while let block = try await source.read(maxFrames: 4096) {
      all.left += block.left
      all.right += block.right
      if all.frames > 20_000 {
        StubServer.serve("/stream/125/aac", .init(body: Data(#"{"error":"This song couldn’t be encoded"}"#.utf8), status: 502))
      }
    }
    // The stream's frames, then the file's from there on, each at its place in the song: four seconds in all,
    // nothing twice or left out.
    #expect(all.frames == 176_400)
    #expect(abs(all.left[176_000] - sine(176_000, 0)) < 1e-6)
    #expect(!support.allows(125))
  }

  @Test func explainsFailuresInTheWebsWords() async throws {
    let (missing, _) = source(106)  // no route: the stub answers 404 {"error":"Unknown track file"}
    await #expect(throws: PlaybackError.server("Unknown track file")) { try await missing.read(maxFrames: 4096) }

    StubServer.serve("/stream/107", .init(body: try Data(contentsOf: AudioFiles.flac(seconds: 2)), breakAfter: 1000, breaks: 4))
    let (breaking, _) = source(107)
    await #expect(throws: PlaybackError.keptBreakingOff) { _ = try await readAll(breaking) }

    StubServer.serve("/stream/108", .init(body: Data(repeating: 0x42, count: 50_000)))
    let (damaged, _) = source(108)
    await #expect(throws: PlaybackError.unsupported) { _ = try await readAll(damaged) }

    StubServer.serve("/stream/109", .init(body: Data(), unreachable: true))
    let (away, _) = source(109)
    await #expect(throws: PlaybackError.unreachable) { _ = try await readAll(away) }
  }
}
