import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct SidebarFooterTests {
  @Test func countsTheLibrary() {
    let footer = SidebarFooter(health: Demo.health, failed: false)
    #expect(footer.stats.map(\.label) == ["Tracks", "Albums", "Runtime", "Size"])
    #expect(footer.stats.map(\.value) == ["8", "3", "45 min", "0.2 GB"])
  }

  @Test func saysWhetherStreamingAndLidarrAnswer() {
    var health = Demo.health
    health.lidarr = HealthStatus.Lidarr(ok: false, error: "Connection refused")
    let footer = SidebarFooter(health: health, failed: false)
    #expect(footer.statuses == [
      .init(label: "Lidarr", state: .down, detail: "Connection refused", saysOffline: true),
      .init(label: "Streaming", state: .ok, detail: "local", saysOffline: false),
    ])
    health.lidarr = HealthStatus.Lidarr(ok: true, version: "2.9.6")
    #expect(SidebarFooter(health: health, failed: false).statuses.first?.detail == "v2.9.6")
  }

  @Test func showsGreyDotsUntilTheServerAnswers() {
    let waiting = SidebarFooter(health: nil, failed: false)
    #expect(waiting.stats.isEmpty)
    #expect(waiting.statuses == [.init(label: "Streaming", state: .unknown, detail: nil, saysOffline: false)])
    let unreachable = SidebarFooter(health: nil, failed: true)
    #expect(unreachable.statuses == [.init(label: "Streaming", state: .down, detail: nil, saysOffline: false)])
  }

  @Test func writesTheVersionAsTheWebDoes() {
    #expect(SidebarFooter.version(AppVersion(marketing: "1.0.0", build: "812")) == "v1.0.0 · 812")
  }
}
