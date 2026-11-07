import PlayarrAPI

/// Every kind of mix, as Settings names and explains it (MixesPanel.tsx: KINDS), and the choices for how they're made.
enum MixKinds {
  static let all: [(kind: MixKind, label: String, description: String)] = [
    (.vibes, "Vibes of the hour", "What you play around this time of day. A new one every hour."),
    (.discovery, "Discovery Weekly", "Songs in your library you haven’t played yet, picked for you. New every Monday."),
    (.repeat, "On Repeat", "Your most played songs of the last 30 days."),
    (.blast, "Blast from the past", "Songs you played a lot, then not for a while."),
    (.genre, "Genre mixes", "One for each style you listen to most."),
    (.deepcuts, "Deep cuts", "The songs you’ve barely played by the artists you love."),
    (.fresh, "Fresh arrivals", "Songs from albums added in the last 30 days."),
    (.decade, "Time machine", "One for each decade you have the most music from."),
    (.energy, "Energy boost", "Songs with a driving beat, building to the peak."),
    (.chill, "Chill", "Laid-back songs with an easy groove, warm and unhurried."),
    (.focus, "Deep focus", "Steady, instrumental music that stays out of the way."),
    (.winddown, "Wind down", "Soft, slow songs for the end of the day, settling down."),
    (.onthisday, "On this day", "Songs from albums released this week in years past."),
  ]

  static let lengths: [(value: Int, label: String)] = [25, 50, 75, 100].map { ($0, String($0)) }
  static let adventure: [(value: Double, label: String)] = [(0, "Familiar"), (0.5, "Balanced"), (1, "Adventurous")]
  static let blast: [(value: Int, label: String)] = [(30, "A month"), (90, "3 months"), (180, "6 months"), (365, "A year")]
  static let counts: [(value: Int, label: String)] = (0...4).map { ($0, String($0)) }

  /// Where a kind's switch lives in the settings the server sends.
  static func setting(_ kind: MixKind) -> WritableKeyPath<MixSettingsInfo.Enabled, Bool?>? {
    switch kind {
    case .vibes: \.vibes
    case .discovery: \.discovery
    case .repeat: \.repeat
    case .blast: \.blast
    case .deepcuts: \.deepcuts
    case .fresh: \.fresh
    case .decade: \.decade
    case .genre: \.genre
    case .energy: \.energy
    case .chill: \.chill
    case .winddown: \.winddown
    case .focus: \.focus
    case .onthisday: \.onthisday
    case .unknown: nil
    }
  }

  /// Where a kind's switch goes in a change.
  static func change(_ kind: MixKind) -> WritableKeyPath<MixSettingsPatch.Enabled, Bool?>? {
    switch kind {
    case .vibes: \.vibes
    case .discovery: \.discovery
    case .repeat: \.repeat
    case .blast: \.blast
    case .deepcuts: \.deepcuts
    case .fresh: \.fresh
    case .decade: \.decade
    case .genre: \.genre
    case .energy: \.energy
    case .chill: \.chill
    case .winddown: \.winddown
    case .focus: \.focus
    case .onthisday: \.onthisday
    case .unknown: nil
    }
  }
}
