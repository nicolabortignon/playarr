import AppIntents

/// The phrases Siri knows without setting anything up, and the actions the Shortcuts app shows for Playarr.
struct PlayarrShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: PlayFavoritesIntent(),
      phrases: ["Play my favorites in \(.applicationName)", "Play my \(.applicationName) favorites"],
      shortTitle: "Play my Favorites", systemImageName: "heart")
    AppShortcut(
      intent: FeelingLuckyIntent(),
      phrases: ["I'm feeling lucky in \(.applicationName)", "Play something lucky in \(.applicationName)"],
      shortTitle: "Feeling lucky", systemImageName: "sparkles")
    AppShortcut(
      intent: StartRadioIntent(),
      phrases: ["Start radio from this song in \(.applicationName)", "Start a \(.applicationName) radio"],
      shortTitle: "Start radio", systemImageName: "dot.radiowaves.left.and.right")
  }
}
