import Foundation

/// What plays without a connection (apps/web/src/player/AudioEngine.tsx `skipToKept`, transitions.ts `maybeAsk`).
public enum OfflinePlayback {
  /// The web's toast when songs are skipped.
  public static let skippedNotice = "Offline: skipped songs that aren’t on this device"
  /// A kept transition whose mix point is closer than this is passed over online, so the server plans from where the
  /// song is (`GIVE_UP_S`).
  public static let giveUpSeconds: Double = 20

  /// The play-order position of the next song on this device after the current one; nil if none (no wrapping round).
  public static func nextKept(in q: QueueState, isKept: (Int) -> Bool) -> Int? {
    guard q.pos >= 0 else { return nil }
    return (q.pos + 1..<q.order.count).first { isKept(q.queue[q.order[$0]].fileId) }
  }

  /// Whether the player plays a kept transition rather than asking the server: always offline (it can't ask); online
  /// only while its mix point is still well ahead of `time` (seconds into A).
  public static func useKept(_ kept: KeptTransitionFiles?, online: Bool, time: Double) -> KeptTransitionFiles? {
    guard let kept else { return nil }
    return !online || time < kept.transition.answer.plan.aStart - giveUpSeconds ? kept : nil
  }
}
