import Foundation
import PlayarrAPI

/// Why a song stopped being the current one.
public enum Finish: Sendable { case ended, changed, closed }

/// The listening history, as heard on this device (apps/web/src/player/playTracker.ts): each song is reported once
/// it stops being the current one, with how long it was actually heard (seeking doesn't count) and where in the day.
public final class PlayTracker {
  /// Heard this long (or half a shorter song): a play.
  public static let playSeconds: Double = 30
  /// Left before this: just looking around, not a verdict on the song.
  public static let skipFromSeconds: Double = 3

  private struct Current {
    let track: Track
    let startedAt: Date
    var heard: Double = 0
    var lastTime: Double?
  }

  private var current: Current?
  private let calendar: Calendar
  private let send: ([PlayReport]) -> Void

  public init(calendar: Calendar = .current, send: @escaping ([PlayReport]) -> Void) {
    self.calendar = calendar
    self.send = send
  }

  public func start(_ track: Track, at date: Date = Date()) {
    current = Current(track: track, startedAt: date)
  }

  /// The playhead moved while playing. Jumps (seeks) aren't counted as heard.
  public func tick(_ time: Double) {
    guard var c = current else { return }
    if let last = c.lastTime {
      let delta = time - last
      if delta > 0 && delta < 2 { c.heard += delta }
    }
    c.lastTime = time
    current = c
  }

  /// Paused, or jumped: the next tick starts counting afresh.
  public func pause() {
    current?.lastTime = nil
  }

  public func finish(_ reason: Finish) {
    guard let c = current else { return }
    current = nil
    let duration = c.track.duration > 0 ? c.track.duration : .infinity
    let played = c.heard >= min(Self.playSeconds, duration / 2)
    let skipped = !played && reason == .changed && c.heard >= Self.skipFromSeconds
    guard played || skipped else { return }
    send([
      PlayReport(
        trackId: c.track.id, recordingId: c.track.recordingId,
        at: c.startedAt.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)),
        hour: calendar.component(.hour, from: c.startedAt),
        weekday: calendar.component(.weekday, from: c.startedAt) - 1,
        seconds: c.heard.rounded(), skipped: skipped)
    ])
  }
}
