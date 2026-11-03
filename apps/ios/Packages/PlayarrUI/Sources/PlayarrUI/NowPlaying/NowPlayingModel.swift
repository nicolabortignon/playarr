import CoreGraphics
import Foundation
import PlayarrAPI
import PlayarrPlayer

/// Now Playing's decisions (apps/web/src/components/NowPlaying.tsx), apart from its view.
@MainActor
struct NowPlayingModel {
  /// Swiping down closes Now Playing past 120 points, or flicked faster than 600 points a second.
  static let closeDistance: CGFloat = 120
  static let closeVelocity: CGFloat = 600

  static func closes(translation: CGFloat, velocity: CGFloat) -> Bool {
    translation > closeDistance || velocity > closeVelocity
  }

  let player: Player

  init(session: AccountSession) {
    player = session.player
  }

  init(player: Player) {
    self.player = player
  }

  /// "Playing from": the queue's source, else the song's album.
  var playingFrom: String? {
    player.queue.source?.label ?? player.queue.currentTrack?.albumTitle
  }

  /// Where "Playing from" goes.
  var playingFromRoute: Route? {
    if let href = player.queue.source?.href, let route = Route(href: href) { return route }
    return player.queue.currentTrack.map { .album($0.albumId) }
  }

  /// "Repeat: off", "Repeat: all", "Repeat: one".
  var repeatLabel: String { "Repeat: \(player.queue.repeatMode.rawValue)" }

  var remaining: String { "-" + Format.time(max(0, player.duration - player.time)) }

  /// The sleep timer's choices, as apps/web/src/components/SleepTimer.tsx.
  static let sleepMinutes: [Double] = [15, 30, 45, 60, 90]

  /// "In 15 minutes", "In an hour", "In 1.5 hours".
  static func sleepLabel(minutes: Double) -> String {
    if minutes < 60 { return "In \(Int(minutes)) minutes" }
    if minutes == 60 { return "In an hour" }
    let hours = minutes / 60
    return "In \(hours == hours.rounded() ? String(Int(hours)) : String(hours)) hours"
  }
}
