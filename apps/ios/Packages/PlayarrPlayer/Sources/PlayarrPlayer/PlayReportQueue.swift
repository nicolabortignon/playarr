import Foundation
import PlayarrAPI

/// Sends play reports, keeping the ones that couldn't go (offline, server restarting) on disk for next time, at most
/// 300. One request at a time: reports arriving meanwhile wait for it, then go together. (The server ignores a report
/// it already has.) As `sendWithRetry` in apps/web/src/player/playTracker.ts.
public actor PlayReportQueue {
  public static let maxPending = 300

  private let file: JSONFile<[PlayReport]>
  private let report: @Sendable ([PlayReport]) async throws -> Void
  private var sending = false

  public init(file: URL, report: @escaping @Sendable ([PlayReport]) async throws -> Void) {
    self.file = JSONFile(file)
    self.report = report
  }

  public var pending: [PlayReport] { file.read() ?? [] }

  public func send(_ plays: [PlayReport]) async {
    write(Array((pending + plays).suffix(Self.maxPending)))
    guard !sending else { return }
    let batch = pending
    guard !batch.isEmpty else { return }
    sending = true
    let sent: Bool
    do {
      try await report(batch)
      write(pending.filter { p in !batch.contains { $0.trackId == p.trackId && $0.at == p.at } })
      sent = true
    } catch {
      sent = false
    }
    sending = false
    // More arrived while this was on its way: send them now.
    if sent && !pending.isEmpty { await send([]) }
  }

  /// Try the waiting reports again (at launch, and when the network comes back).
  public func retry() async { await send([]) }

  private func write(_ plays: [PlayReport]) { file.write(plays.isEmpty ? nil : plays) }
}
