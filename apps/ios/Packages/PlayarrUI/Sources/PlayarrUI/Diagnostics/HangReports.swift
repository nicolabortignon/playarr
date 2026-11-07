import Foundation
import Synchronization

#if canImport(MetricKit)
  import MetricKit
#endif

/// The hangs and crashes MetricKit reports for this app (on the launch after they happen), kept as a line each in
/// Application Support for Settings → Copy diagnostics (plan 3 §6): the newest 20. Nothing leaves the device.
public final class HangReports: NSObject, Sendable {
  public static let shared = HangReports(file: URL.applicationSupportDirectory.appending(path: "Playarr/metric-reports.json"))
  static let kept = 20

  private let file: URL
  private let lines: Mutex<[String]>

  init(file: URL) {
    self.file = file
    let saved = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
    lines = Mutex(saved)
  }

  /// The reports kept, oldest first.
  public var reports: [String] { lines.withLock { $0 } }

  /// Asks MetricKit for this app's reports (once, at launch).
  public func start() {
    #if canImport(MetricKit) && os(iOS)
      MXMetricManager.shared.add(self)
    #endif
  }

  /// Keeps `new` lines after the ones kept, the newest `kept` of them.
  func keep(_ new: [String]) {
    guard !new.isEmpty else { return }
    let all = lines.withLock { lines in
      lines = Array((lines + new).suffix(Self.kept))
      return lines
    }
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? JSONEncoder().encode(all).write(to: file, options: .atomic)
  }
}

#if canImport(MetricKit) && os(iOS)
  extension HangReports: MXMetricManagerSubscriber {
    public func didReceive(_ payloads: [MXDiagnosticPayload]) {
      keep(payloads.flatMap(Self.lines))
    }

    /// "2026-11-07 17:02 · hang of 1.4 s", "… · crash: EXC_BAD_ACCESS (SIGSEGV)".
    static func lines(_ payload: MXDiagnosticPayload) -> [String] {
      let when = payload.timeStampEnd.formatted(.iso8601.year().month().day().time(includingFractionalSeconds: false))
      let hangs = (payload.hangDiagnostics ?? []).map { hang in
        "\(when) · hang of \(hang.hangDuration.converted(to: .seconds).value.formatted(.number.precision(.fractionLength(1)))) s"
      }
      let crashes = (payload.crashDiagnostics ?? []).map { crash in
        let what = [crash.exceptionType.map { "exception \($0)" }, crash.signal.map { "signal \($0)" }, crash.terminationReason]
          .compactMap { $0 }.joined(separator: ", ")
        return "\(when) · crash: \(what.isEmpty ? "no reason given" : what)"
      }
      return hangs + crashes
    }
  }
#endif
