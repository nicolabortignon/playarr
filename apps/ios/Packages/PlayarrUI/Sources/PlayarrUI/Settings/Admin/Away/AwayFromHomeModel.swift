import Foundation
import Observation
import PlayarrAPI

/// Settings → Away from home (admins; the web's AwayFromHomePanel): is this server reachable from outside over HTTPS?
/// The server asks its own public address (PUBLIC_URL) the way a phone would, step by step, and says what to fix; the
/// guide shows how to get one (Caddy with a domain, or Tailscale).
@MainActor @Observable
public final class AwayFromHomeModel {
  public static let intro =
    "Away from home, phones and computers reach Playarr at its public address, over HTTPS. The check asks that address from the server itself, the way a phone would, and says what to fix."
  public static let guideIntro = "Two ways: Caddy with a domain of your own, or Tailscale without one."
  /// docs/server/https.md, as the web links it.
  public static let guide = URL(string: "https://github.com/nicolabortignon/playarr/blob/main/docs/server/https.md")
  public static let notChecked = "Not checked yet."

  /// The server's public address: GET /api/server's, until a check says otherwise.
  public private(set) var publicUrl: String?
  /// The address is known (or known to be unset), from the server or a check.
  public private(set) var addressKnown = false
  public private(set) var result: ReachabilityCheck?
  public private(set) var checking = false
  /// Why the last check couldn't run.
  public private(set) var notice: String?

  @ObservationIgnored private let api: any APISending

  public init(api: any APISending) {
    self.api = api
  }

  public func load() async {
    let info = try? await api.send(API.Server.info())
    guard result == nil else { return }
    publicUrl = info?.publicUrl
    addressKnown = true
  }

  /// A few seconds at most: the server's own timeouts are short.
  public func check() async {
    checking = true
    defer { checking = false }
    do {
      let check = try await api.send(API.Settings.checkReachability())
      result = check
      publicUrl = check.publicUrl
      addressKnown = true
      notice = nil
    } catch {
      notice = "Couldn’t check: \(failureText(error))"
    }
  }

  public var checkLabel: String { checking ? "Checking…" : "Check now" }
  public var addressText: String { publicUrl ?? "Not set yet" }

  /// "Checked 7:30 PM".
  public func checkedText() -> String? {
    guard let result, let at = AdminText.date(result.checkedAt) else { return nil }
    return "Checked \(at.formatted(date: .omitted, time: .shortened))"
  }

  /// A step's status in words, for VoiceOver (the web's, too).
  public static func word(_ status: ReachabilityStatus) -> String {
    switch status {
    case .ok: "passed"
    case .warn: "not certain"
    case .fail: "failed"
    case .skipped, .unknown: "not checked"
    }
  }

  public static func symbol(_ status: ReachabilityStatus) -> String {
    switch status {
    case .ok: "checkmark"
    case .warn: "exclamationmark.triangle"
    case .fail: "xmark"
    case .skipped, .unknown: "minus"
    }
  }

  public static func symbol(_ verdict: ReachabilityVerdict) -> String {
    switch verdict {
    case .reachable: "checkmark.circle"
    case .unconfirmed: "exclamationmark.triangle"
    case .unreachable, .unknown: "exclamationmark.circle"
    }
  }
}
