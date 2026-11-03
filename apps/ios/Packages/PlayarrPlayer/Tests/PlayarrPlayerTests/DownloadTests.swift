import Foundation
import Testing
@testable import PlayarrPlayer

@Suite(.serialized)
struct DownloadTests {
  let body = Data((0..<200_000).map { UInt8($0 % 251) })

  func download(_ path: String, firstByte: Int64 = 0, file: URL? = nil, finalFile: URL? = nil) -> Download {
    Download(
      request: StubServer.request(path), firstByte: firstByte, file: file ?? temporaryDirectory().appending(path: "f.part"),
      finalFile: finalFile, retryDelay: .milliseconds(5), configuration: StubServer.configuration)
  }

  @Test func readersGetBytesAsTheyArrive() async throws {
    StubServer.serve("/stream/1", .init(body: body))
    let d = download("/stream/1")
    d.start()
    let first = try await d.bytes(at: 0, maxLength: 1000)
    #expect(first == body.prefix(first.count))
    #expect(!first.isEmpty)
    let later = try await d.bytes(at: 150_000, maxLength: 10)
    #expect(later == body.subdata(in: 150_000..<150_000 + later.count))
    try await d.waitUntilFinished()
    #expect(try await d.bytes(at: Int64(body.count), maxLength: 10).isEmpty)
    #expect(try Data(contentsOf: d.file) == body)
  }

  @Test func aBrokenConnectionIsAskedAgainFromWhereItStoppedThreeTimes() async throws {
    StubServer.serve("/stream/2", .init(body: body, breakAfter: 50_000, breaks: 3))
    let d = download("/stream/2")
    d.start()
    try await d.waitUntilFinished()
    #expect(try Data(contentsOf: d.file) == body)
    // Each time from the byte it had (bytes in flight when a connection breaks may be lost, so not always 50 000).
    let ranges = StubServer.requests("/stream/2")
    #expect(ranges.count == 4)
    #expect(ranges.first == .some(nil))
    let starts = ranges.dropFirst().compactMap { $0.flatMap { Int($0.dropFirst("bytes=".count).dropLast()) } }
    #expect(starts.count == 3 && starts == starts.sorted() && starts.allSatisfy { $0 > 0 })
  }

  @Test func aFourthBreakIsAFailure() async throws {
    StubServer.serve("/stream/3", .init(body: body, breakAfter: 10_000, breaks: 4))
    let d = download("/stream/3")
    d.start()
    await #expect(throws: Download.Failure.network) { try await d.waitUntilFinished() }
  }

  @Test func theServersRefusalCarriesItsMessage() async throws {
    StubServer.serve("/stream/4", .init(body: Data(#"{"error":"Cannot read audio file: gone"}"#.utf8), status: 502))
    let d = download("/stream/4")
    d.start()
    await #expect(throws: Download.Failure.server(status: 502, message: "Cannot read audio file: gone")) {
      try await d.bytes(at: 0, maxLength: 10)
    }
  }

  @Test func startsFromAByteAndContinuesAnEarlierFile() async throws {
    StubServer.serve("/stream/5", .init(body: body))
    let dir = temporaryDirectory()
    let part = dir.appending(path: "5.flac.part")
    try body.prefix(70_000).write(to: part)
    let d = download("/stream/5", file: part, finalFile: dir.appending(path: "5.flac"))
    d.start()
    try await d.waitUntilFinished()
    #expect(StubServer.requests("/stream/5") == ["bytes=70000-"])
    #expect(d.file == dir.appending(path: "5.flac"))
    #expect(try Data(contentsOf: d.file) == body)

    StubServer.serve("/levelled", .init(body: body))
    let fromByte = download("/levelled", firstByte: 1000)
    fromByte.start()
    try await fromByte.waitUntilFinished()
    #expect(try Data(contentsOf: fromByte.file) == body.dropFirst(1000))
  }

  @Test func aServerIgnoringTheRangeStillGivesTheRightBytes() async throws {
    StubServer.serve("/stream/6", .init(body: body, ignoresRange: true))
    let d = download("/stream/6", firstByte: 5000)
    d.start()
    try await d.waitUntilFinished()
    #expect(try Data(contentsOf: d.file) == body.dropFirst(5000))
  }

  @Test func aCancelledReaderStopsWaiting() async throws {
    StubServer.serve("/stream/7", .init(body: body, pause: .seconds(10)))
    let d = download("/stream/7")
    d.start()
    let reader = Task { try await d.bytes(at: 190_000, maxLength: 10) }
    try await Task.sleep(for: .milliseconds(20))
    reader.cancel()
    await #expect(throws: CancellationError.self) { try await reader.value }
    d.cancel()
  }
}
