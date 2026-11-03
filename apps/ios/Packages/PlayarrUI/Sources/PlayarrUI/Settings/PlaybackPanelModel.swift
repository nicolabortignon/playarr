import PlayarrPlayer

/// Settings → Playback's one rule beyond storing (apps/web/src/lib/prefs.ts `setTransitions`): a fade of 0 seconds
/// would sound like Off, so choosing Crossfade or DJ mix starts at 6 s.
@MainActor
struct PlaybackPanelModel {
  static let firstCrossfade: Double = 6
  /// Lengths offered once Crossfade or DJ mix is chosen: 0 would just be Off.
  static let lengths = PlaybackSettings.crossfades.filter { $0 > 0 }

  let settings: PlaybackSettings

  func choose(_ transitions: PlaybackSettings.Transitions) {
    settings.transitions = transitions
    if transitions != .off, settings.crossfade == 0 { settings.crossfade = Self.firstCrossfade }
  }
}
