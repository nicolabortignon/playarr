import Foundation
import Testing
@testable import PlayarrPlayer

struct TransportFilesTests {
  func response(_ status: Int) -> HTTPURLResponse {
    HTTPURLResponse(url: URL(string: "https://playarr.test/stream/12")!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
  }

  @Test func putsAFinishedFileAtItsPlaceBeforeURLSessionDeletesIt() throws {
    let base = temporaryDirectory()
    let location = temporaryDirectory().appending(path: "CFNetworkDownload_1.tmp")
    try Data(count: 1234).write(to: location)
    let event = TransportFiles.finish(id: "srv/1/stream/12.flac", location: location, response: response(200), base: base)
    #expect(event == .finished(id: "srv/1/stream/12.flac", bytes: 1234))
    #expect(FileManager.default.fileExists(atPath: base.appending(path: "srv/1/stream/12.flac").path()))
    #expect(!FileManager.default.fileExists(atPath: location.path()))
  }

  @Test func readsTheServersRefusal() throws {
    let location = temporaryDirectory().appending(path: "body.tmp")
    try Data(#"{"error":"Unknown track file"}"#.utf8).write(to: location)
    let event = TransportFiles.finish(id: "srv/1/stream/12.flac", location: location, response: response(404), base: temporaryDirectory())
    #expect(event == .failed(id: "srv/1/stream/12.flac", failure: .server(status: 404, message: "Unknown track file"), resumeData: nil))
  }

  @Test func keepsResumeDataOfAnInterruptedTaskAndTellsACancelApart() {
    let resume = Data([1, 2, 3])
    let lost = NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost, userInfo: [NSURLSessionDownloadTaskResumeData: resume])
    #expect(TransportFiles.complete(id: "j", error: lost) == .failed(id: "j", failure: .network(lost.localizedDescription), resumeData: resume))
    let quit = NSError(
      domain: NSURLErrorDomain, code: NSURLErrorCancelled,
      userInfo: [NSURLSessionDownloadTaskResumeData: resume, NSURLErrorBackgroundTaskCancelledReasonKey: NSURLErrorCancelledReasonUserForceQuitApplication])
    #expect(TransportFiles.complete(id: "j", error: quit) == .failed(id: "j", failure: .cancelled, resumeData: resume))
    #expect(TransportFiles.complete(id: "j", error: nil) == nil)
  }

  @Test func onlyPutsFilesUnderItsBase() {
    let base = URL(filePath: "/tmp/Playarr/")
    #expect(TransportFiles.destination(of: "srv/1/stream/12.flac", base: base)?.path() == "/tmp/Playarr/srv/1/stream/12.flac")
    #expect(TransportFiles.destination(of: "srv/../../etc/passwd", base: base) == nil)
    #expect(TransportFiles.destination(of: "/etc/passwd", base: base) == nil)
  }
}

@Suite(.serialized)
struct URLSessionTransportTests {
  let body = Data((0..<150_000).map { UInt8($0 % 251) })

  func transport(base: URL) -> (URLSessionTransport, Recorder<TransportEvent>) {
    let events = Recorder<TransportEvent>()
    let t = URLSessionTransport(configuration: StubServer.configuration(), base: base)
    t.setHandler { events.append($0) }
    return (t, events)
  }

  /// The event that ended the job.
  func done(_ events: Recorder<TransportEvent>) -> TransportEvent? {
    events.all.first { if case .progress = $0 { false } else { true } }
  }

  @Test func downloadsAFileToItsPlaceWithProgress() async throws {
    StubServer.serve("/stream/301", .init(body: body))
    let base = temporaryDirectory()
    let (t, events) = transport(base: base)
    t.start(TransportJob(id: "srv/1/stream/301.flac", request: StubServer.request("/stream/301")))
    await eventuallyAsync { done(events) != nil }
    #expect(done(events) == .finished(id: "srv/1/stream/301.flac", bytes: 150_000))
    #expect(try Data(contentsOf: base.appending(path: "srv/1/stream/301.flac")) == body)
    #expect(events.all.contains { if case .progress(_, let written, _) = $0 { written > 0 } else { false } })
  }

  @Test func aRefusalAndACancelEndTheJob() async throws {
    let (t, events) = transport(base: temporaryDirectory())
    t.start(TransportJob(id: "srv/1/stream/302.flac", request: StubServer.request("/stream/302")))  // no route: 404
    await eventuallyAsync { done(events) != nil }
    #expect(done(events) == .failed(id: "srv/1/stream/302.flac", failure: .server(status: 404, message: "Unknown track file"), resumeData: nil))

    StubServer.serve("/stream/303", .init(body: body, pause: .seconds(5)))
    let (slow, slowEvents) = transport(base: temporaryDirectory())
    slow.start(TransportJob(id: "srv/1/stream/303.flac", request: StubServer.request("/stream/303")))
    await eventuallyAsync { await slow.running() == ["srv/1/stream/303.flac"] }
    slow.cancel("srv/1/stream/303.flac")
    await eventuallyAsync { done(slowEvents) != nil }
    guard case .failed(_, .cancelled, _) = done(slowEvents) else { Issue.record("not cancelled: \(String(describing: done(slowEvents)))"); return }
  }

  @Test func handsOverEventsFromBeforeItHadAHandler() async throws {
    StubServer.serve("/stream/304", .init(body: body))
    let t = URLSessionTransport(configuration: StubServer.configuration(), base: temporaryDirectory())
    t.start(TransportJob(id: "srv/1/stream/304.flac", request: StubServer.request("/stream/304")))
    try await Task.sleep(for: .milliseconds(300))
    let events = Recorder<TransportEvent>()
    t.setHandler { events.append($0) }
    await eventuallyAsync { done(events) != nil }
    #expect(done(events) == .finished(id: "srv/1/stream/304.flac", bytes: 150_000))
  }
}
