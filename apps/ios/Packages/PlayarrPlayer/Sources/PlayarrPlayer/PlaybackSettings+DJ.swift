import Foundation

extension PlaybackSettings {
  /// With DJ mix, how long songs that can't be mixed on the beat fade into each other: the crossfade length, or 6 s
  /// when none is picked (`djFadeSeconds` in apps/web/src/lib/prefs.ts).
  public var djFadeSeconds: Double { crossfade > 0 ? crossfade : 6 }
}
