import PlayarrAPI

/// How one song goes into the next, as apps/web/src/player/decks.ts decides it.
public enum JoinRules {
  /// `b` is the song after `a` on the same album: the two are heard as one, never faded into each other.
  public static func continues(_ a: Track?, _ b: Track?) -> Bool {
    guard let a, let b, a.albumId == b.albumId else { return false }
    return (b.discNumber == a.discNumber && b.trackNumber == a.trackNumber + 1)
      || (b.discNumber == a.discNumber + 1 && b.trackNumber == 1)
  }

  /// How long `a`'s end and `b`'s start overlap: none within an album, never more than a third of either song.
  public static func fadeSeconds(_ a: Track?, _ b: Track?, crossfade: Double) -> Double {
    guard let a, let b, crossfade > 0, !continues(a, b) else { return 0 }
    return min(crossfade, a.duration / 3, b.duration / 3)
  }

  /// How much to turn a song (dB) so it's as loud as the others. Within an album played in order the album's
  /// level applies, so its quiet songs stay quiet next to its loud ones.
  public static func levelDb(_ track: Track, _ level: TrackLevel, in s: QueueState) -> Double {
    let at = s.order.indices.first { p in abs(p - s.pos) <= 2 && s.queue[s.order[p]].fileId == track.fileId }
    let before = at.flatMap { $0 > 0 ? s.queue[s.order[$0 - 1]] : nil }
    let after = at.flatMap { $0 + 1 < s.order.count ? s.queue[s.order[$0 + 1]] : nil }
    let inAlbum = continues(before, track) || continues(track, after)
    return inAlbum ? level.album ?? level.track : level.track
  }
}
