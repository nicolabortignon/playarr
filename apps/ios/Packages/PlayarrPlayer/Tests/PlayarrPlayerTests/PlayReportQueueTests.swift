import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrPlayer

/// Ported from the sendWithRetry tests in apps/web/src/player/playTracker.test.ts.
struct PlayReportQueueTests {
  func report(_ n: Int) -> PlayReport {
    PlayReport(trackId: n, recordingId: "rec-\(n)", at: "2026-11-01T10:0\(n):00.000Z", hour: 10, weekday: 0, seconds: 60, skipped: false)
  }

  func file() -> URL { FileManager.default.temporaryDirectory.appending(path: "plays-\(UUID().uuidString).json") }

  @Test func keepsReportsThatCouldNotBeSentAndSendsThemWithTheNextOne() async {
    let url = file()
    let offline = PlayReportQueue(file: url) { _ in throw URLError(.notConnectedToInternet) }
    await offline.send([report(1)])
    #expect(await offline.pending == [report(1)])
    let received = Mutex<[[PlayReport]]>([])
    let online = PlayReportQueue(file: url) { plays in received.withLock { $0.append(plays) } }
    await online.send([report(2)])
    #expect(received.withLock { $0 } == [[report(1), report(2)]])
    #expect(await online.pending.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: url.path()))
  }

  @Test func keepsAtMostThreeHundred() async {
    let queue = PlayReportQueue(file: file()) { _ in throw URLError(.timedOut) }
    await queue.send((0..<310).map { PlayReport(trackId: $0, recordingId: "r", at: "\($0)", hour: 0, weekday: 0, seconds: 30, skipped: false) })
    let pending = await queue.pending
    #expect(pending.count == 300)
    #expect(pending.first?.trackId == 10)
  }

  @Test func sendsOneRequestAtATimeReportsMadeMeanwhileFollowOnceItIsAnswered() async {
    let calls = Mutex<[[PlayReport]]>([])
    let gate = Gate()
    let queue = PlayReportQueue(file: file()) { plays in
      calls.withLock { $0.append(plays) }
      await gate.wait()
    }
    async let first: Void = queue.send([report(1)])
    while calls.withLock({ $0.isEmpty }) { await Task.yield() }
    await queue.send([report(2)])  // waits on disk: one request is on its way
    #expect(calls.withLock { $0.count } == 1)
    await gate.open()
    while calls.withLock({ $0.count }) < 2 { await Task.yield() }
    await gate.open()
    await first
    #expect(calls.withLock { $0 } == [[report(1)], [report(2)]])
    #expect(await queue.pending.isEmpty)
  }
}
