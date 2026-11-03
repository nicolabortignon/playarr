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
