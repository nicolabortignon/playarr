import Foundation
import Observation
import PlayarrAPI

/// Settings → Mixes → Last.fm, for the account signed in, as on the web (LastFmSection.tsx): an admin adds the
/// server's Last.fm API account once; then each account connects (allow Playarr on Last.fm, then finish), sends plays
/// on or off, sends earlier plays, disconnects. Refreshed every 30 s while on screen, to show plays going out.
@MainActor @Observable
public final class LastFmModel {
  /// Nil until loaded, and on a server without Last.fm (the section isn't shown then).
  public private(set) var info: LastFmInfo?
  /// Connecting, between its halves: the Last.fm page to allow Playarr on, and the token to finish with.
  public private(set) var waiting: LastFmConnect?
  public var apiKey = ""
  public var secret = ""
  public private(set) var busy = false
  public private(set) var notice: String?
  public private(set) var failed = false

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let clock: any Clock<Duration>

  public static let intro = "Send each song heard (for half its length, or four minutes) to your Last.fm profile, as ListenBrainz does."
  public static let appHelp =
    "This server needs a Last.fm API account first, once: create one (any name; the callback URL can stay empty), then give its API key and shared secret here. Everyone here then connects their own Last.fm."
  public static let appPage = URL(string: "https://www.last.fm/api/account/create")

  public init(api: any APISending, clock: any Clock<Duration> = ContinuousClock()) {
    self.api = api
    self.clock = clock
  }

  public func poll() async {
    await Polling.run(clock: clock, interval: { .seconds(30) }) { [weak self] in await self?.load() }
  }

  public func load() async {
    if let info = try? await api.send(API.Settings.lastFm()) { self.info = info }
  }

  public var canAddApp: Bool { !apiKey.trimmed.isEmpty && !secret.trimmed.isEmpty && !busy }

  public func addApp() async {
    guard canAddApp else { return }
    if await act(API.Settings.saveLastFmApp(apiKey: apiKey.trimmed, secret: secret.trimmed), done: "Last.fm added to this server") {
      apiKey = ""
      secret = ""
    }
  }

  public func removeApp() async {
    await act(API.Settings.removeLastFmApp(), done: "Last.fm removed from this server")
  }

  /// The first half: the page where the account allows Playarr.
  public func connect() async {
    busy = true
    defer { busy = false }
    do {
      waiting = try await api.send(API.Settings.connectLastFm())
      notice = nil
      failed = false
    } catch {
      notice = failureText(error)
      failed = true
    }
  }

  /// The second half, once Playarr is allowed on Last.fm (the server says so until it is).
  public func finish() async {
    guard let waiting else { return }
    if await act(API.Settings.finishLastFm(token: waiting.token)) { self.waiting = nil }
  }

  public func cancel() {
    waiting = nil
  }

  public func setEnabled(_ on: Bool) async {
    await act(API.Settings.saveLastFm(enabled: on))
  }

  public func disconnect() async {
    await act(API.Settings.disconnectLastFm(), done: "Last.fm disconnected")
  }

  public func sendEarlier() async {
    await act(API.Settings.sendEarlierToLastFm(), done: "Sending your earlier plays to Last.fm")
  }

  public var switchLabel: String { "Send plays to \(info?.user ?? "Last.fm")" }

  /// "120 scrobbles sent · 3 waiting · last 3 Nov 2026 at 10:00", or why sending stopped.
  public var switchDetail: String {
    guard let info else { return "" }
    if let error = info.error { return error }
    return [
      "\(AdminText.plural(info.sent, "scrobble")) sent",
      info.pending > 0 ? "\(info.pending) waiting" : nil,
      info.lastSentAt.flatMap(AdminText.date).map { "last \($0.formatted(date: .abbreviated, time: .shortened))" },
    ].compactMap { $0 }.joined(separator: " · ")
  }

  /// "Also send 12 earlier plays", while there are some (the last two weeks', as Last.fm takes no older).
  public var earlierLabel: String? {
    guard let earlier = info?.earlier, earlier > 0 else { return nil }
    return "Also send \(AdminText.plural(earlier, "earlier play"))"
  }

  /// For an admin: "This server's Last.fm API account: …abc123".
  public var appLine: String? {
    guard let key = info?.apiKey, info?.available == true else { return nil }
    return "This server’s Last.fm API account: …\(key.suffix(6))"
  }

  @discardableResult
  private func act(_ endpoint: Endpoint<LastFmInfo>, done: String? = nil) async -> Bool {
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
