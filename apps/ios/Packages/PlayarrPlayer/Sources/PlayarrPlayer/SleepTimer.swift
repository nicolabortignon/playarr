import Foundation
import Observation

/// The sleep timer (apps/web/src/player/sleep.ts): stop after a while, fading out over the last 20 s, or when this
/// song ends. Once it has stopped the music, Now Playing says goodnight (`sleptAt`).
@MainActor @Observable
public final class SleepTimer {
  public static let fadeSeconds: TimeInterval = 20

  /// When the music stops.
  public private(set) var endsAt: Date?
  /// Stop when the song playing ends.
  public private(set) var endOfSong = false
  /// When the timer last stopped the music, until something wakes the screen (a touch, the music playing again): Now
  /// Playing shows a moon and "Sleep well", or a toast says it where Now Playing is closed.
  public private(set) var sleptAt: Date?

  public init() {}

  public func sleep(minutes: Double, from now: Date = Date()) {
    endsAt = now.addingTimeInterval(minutes * 60)
    endOfSong = false
    sleptAt = nil
  }

  public func sleepAtEndOfSong() {
    endsAt = nil
    endOfSong = true
    sleptAt = nil
  }

  public func cancel() {
    endsAt = nil
    endOfSong = false
  }

  /// How loud to play as the timer runs out: 1, then down to 0 over the fade.
  public func gain(at now: Date = Date()) -> Float {
    guard let endsAt else { return 1 }
    return Float(max(0, min(1, endsAt.timeIntervalSince(now) / Self.fadeSeconds)))
  }

  /// True once, when the timer has run out (it is then cancelled): the player pauses.
  public func runsOut(at now: Date = Date()) -> Bool {
    guard let endsAt, now >= endsAt else { return false }
    cancel()
    return true
  }

  /// Called when a song ends on its own: true if the timer stops the music here.
  public func stopsAtSongEnd() -> Bool {
    guard endOfSong else { return false }
    cancel()
    return true
  }

  /// The timer has stopped the music (its time ran out, or the song it waited for ended): time to say goodnight.
  public func fellAsleep(at now: Date = Date()) {
    sleptAt = now
  }

  /// Done with goodnight: a touch, or the music playing again.
  public func wake() {
    guard sleptAt != nil else { return }
    sleptAt = nil
  }

  /// "23 min" left, for the timer's button.
  public func label(at now: Date = Date()) -> String? {
    if endOfSong { return "End of song" }
    guard let endsAt else { return nil }
    let minutes = max(1, Int((endsAt.timeIntervalSince(now) / 60).rounded(.up)))
    guard minutes >= 60 else { return "\(minutes) min" }
    return minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(minutes % 60) min"
  }
}
