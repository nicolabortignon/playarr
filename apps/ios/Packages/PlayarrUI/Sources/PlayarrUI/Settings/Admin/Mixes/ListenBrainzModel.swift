import Foundation
import Observation
import PlayarrAPI

/// Settings → Mixes → ListenBrainz, for the account signed in: connect with a user token, send plays on or
/// off, send earlier plays, disconnect. Refreshed every 30 s while on screen, to show plays going out.
@MainActor @Observable
public final class ListenBrainzModel {
  /// Nil until loaded, and on a server without ListenBrainz (the section isn't shown then).
  public private(set) var info: ListenBrainzInfo?
  public var token = ""
  public private(set) var busy = false
  public private(set) var notice: String?
  public private(set) var failed = false

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let clock: any Clock<Duration>

  public static let intro =
    "Send each song heard (for half its length, or four minutes) to your ListenBrainz profile. Its recommendations, which radio and suggestions use, then learn from what you play."
  public static let tokenHelp = "Your user token, from listenbrainz.org/settings"
  public static let tokenPage = URL(string: "https://listenbrainz.org/settings/")

  public init(api: any APISending, clock: any Clock<Duration> = ContinuousClock()) {
    self.api = api
    self.clock = clock
  }

  public func poll() async {
    await Polling.run(clock: clock, interval: { .seconds(30) }) { [weak self] in await self?.load() }
  }

  public func load() async {
    if let info = try? await api.send(API.Settings.listenBrainz()) { self.info = info }
  }

  public var canConnect: Bool { !token.trimmed.isEmpty && !busy }

  public func connect() async {
    guard canConnect else { return }
    if await act(API.Settings.saveListenBrainz(token: token.trimmed)) { token = "" }
  }

  public func setEnabled(_ on: Bool) async {
    await act(API.Settings.saveListenBrainz(enabled: on))
  }

  public func disconnect() async {
    await act(API.Settings.disconnectListenBrainz(), done: "ListenBrainz disconnected")
  }

  public func sendEarlier() async {
    await act(API.Settings.sendEarlierListens(), done: "Sending your earlier plays to ListenBrainz")
  }

  public var switchLabel: String { "Send plays to \(info?.user ?? "ListenBrainz")" }

  /// "120 listens sent · 3 waiting · last 3 Nov 2026 at 10:00", or why sending stopped.
  public var switchDetail: String {
    guard let info else { return "" }
    if let error = info.error { return error }
    return [
      "\(AdminText.plural(info.sent, "listen")) sent",
      info.pending > 0 ? "\(info.pending) waiting" : nil,
      info.lastSentAt.flatMap(AdminText.date).map { "last \($0.formatted(date: .abbreviated, time: .shortened))" },
    ].compactMap { $0 }.joined(separator: " · ")
  }

  /// "Also send 1,200 earlier plays", while there are some.
  public var earlierLabel: String? {
    guard let earlier = info?.earlier, earlier > 0 else { return nil }
    return "Also send \(AdminText.plural(earlier, "earlier play"))"
  }

  @discardableResult
  private func act(_ endpoint: Endpoint<ListenBrainzInfo>, done: String? = nil) async -> Bool {
    busy = true
    defer { busy = false }
    do {
      info = try await api.send(endpoint)
      notice = done
      failed = false
      return true
    } catch {
      notice = failureText(error)
      failed = true
      return false
    }
  }
}
