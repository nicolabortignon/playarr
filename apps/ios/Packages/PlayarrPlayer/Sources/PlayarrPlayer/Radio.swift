import PlayarrAPI

/// Radio continuation (apps/web/src/player/radio.ts): when the last song of the queue starts and nothing repeats,
/// ask for songs like the last few played, so playback carries on without a gap.
public enum Radio {
  /// Songs to base what comes next on: the last few played.
  public static let seedCount = 5
  public static let count = 25

  /// What to ask `POST /api/radio` for now, or nil when it shouldn't ask.
  public static func continuation(for q: QueueState, autoplay: Bool) -> (seeds: [String], exclude: [String])? {
    guard autoplay, q.currentTrack != nil, q.repeatMode == .off, q.pos == q.order.count - 1 else { return nil }
    let played = q.order.prefix(q.pos + 1).map { q.queue[$0] }
    return (played.suffix(seedCount).map(\.recordingId), q.queue.map(\.recordingId))
  }

  /// "Playing from" for Start radio on a song.
  public static func source(for track: Track) -> PlaySource {
    PlaySource(label: "\(track.title) radio", href: "/albums/\(track.albumId)")
  }
}
