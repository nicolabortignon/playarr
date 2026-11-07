import Foundation
import OSLog
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct DiagnosticsTests {
  @Test func saysWhatTheAppAndTheServerAreUpToWithoutAddresses() async throws {
    let app = AppModel.demo()
    let session = try #require(app.session)
    let report = await Diagnostics.gather(app: app, session: session, reports: ["2026-11-07T17:02:00Z · hang of 1.4 s"], log: { [] })
    #expect(report.server == "Playarr 0.0.0, for apps from 1.0.0")
    #expect(report.account == "admin")
    #expect(report.addresses == "public (https); no home address")
    #expect(report.player == "nothing queued")
    #expect(report.problem == nil)
    #expect(report.downloads.hasPrefix("0 downloads, 0 songs kept"))

    session.player.play(Demo.tracks, startAt: 1)
    let playing = await Diagnostics.gather(app: app, session: session, reports: [], log: { [] })
    #expect(playing.player.hasPrefix("playing song 2 of \(Demo.tracks.count) (id \(Demo.tracks[1].id)) at "), "\(playing.player)")
    let text = playing.text
    #expect(text.contains("Server: Playarr 0.0.0"))
    #expect(text.contains("No hang or crash reports from MetricKit."))
    // Where the server is, the token and the songs' names stay out.
    #expect(!text.contains("playarr.invalid"))
    #expect(!text.contains(Demo.tracks[1].title))
    session.close()
  }

  @Test func readsBackTheAppsOwnLog() async throws {
    let mark = UUID().uuidString
    Log.player.info("Diagnostics test \(mark, privacy: .public)")
    // The system keeps log entries a moment after they're made.
    var lines: [String] = []
    for _ in 0..<20 where !lines.contains(where: { $0.contains(mark) }) {
      try await Task.sleep(for: .milliseconds(100))
      lines = await Task.detached { Diagnostics.recentLog() }.value
    }
    #expect(lines.contains { $0.contains("[player] Diagnostics test \(mark)") })
  }

  @Test func keepsTheNewestMetricKitReportsAcrossLaunches() throws {
    let file = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)/metric-reports.json")
    let reports = HangReports(file: file)
    reports.keep((1...15).map { "report \($0)" })
    reports.keep((16...25).map { "report \($0)" })
    #expect(reports.reports == (6...25).map { "report \($0)" })
    // The next launch reads them back.
    #expect(HangReports(file: file).reports == reports.reports)
  }
}
