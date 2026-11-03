import Foundation
import PlayarrAPI

/// The songs to have on this device ahead of playback, most urgent first (`loadAheadPlan` and `reach` in
/// apps/web/src/player/loadAhead.ts): the next 3 in play order on Wi-Fi (round to the first when repeating the queue),
/// then the current one; the next 1 on mobile data; none in Low Data Mode or offline; with repeat one, the current
/// song first. Nothing when keeping songs is off. This is the one way songs are fetched ahead: the stream cache fetches
/// the plan, and the download store keeps it (and what plays now and next) from being dropped.
public enum KeepAhead {
  /// Wait for the queue to settle, so skipping through songs doesn't download each one.
  public static let settle: Duration = .milliseconds(2500)

  public static func plan(_ q: QueueState, network: NetworkKind, limit: Int64) -> [Track] {
    guard limit > 0 else { return [] }
    return plan(q, ahead: PrefetchPolicy.songsAhead(on: network), withCurrent: network == .wifi)
  }

  static func plan(_ q: QueueState, ahead: Int, withCurrent: Bool) -> [Track] {
    guard let current = q.currentTrack else { return [] }
    let upcoming = q.upcoming(ahead)
    let plan = q.repeatMode == .one ? [current] + upcoming : withCurrent ? upcoming + [current] : upcoming
    var seen = Set<Int>()
    return plan.filter { seen.insert($0.fileId).inserted }
  }
}
