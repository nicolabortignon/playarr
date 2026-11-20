import AppIntents

#if !WIDGET_EXTENSION
  import PlayarrUI
#endif

// Compiled into the app and the widget extension (plan 11): a widget's button names one of these, and the system
// performs audio playback intents in the app's process, starting it in the background if need be. So the extension
// only declares them (WIDGET_EXTENSION); the app's perform them, through its model.

/// "Play my Favorites": the Favorites page's Play, from Siri, Shortcuts, Spotlight or the Action button. An audio
/// playback intent, so it plays without bringing the app to the front.
struct PlayFavoritesIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Play my Favorites"
  static let description = IntentDescription("Plays your Favorites in order.")

  #if WIDGET_EXTENSION
    func perform() async throws -> some IntentResult { .result() }
  #else
    @Dependency private var model: AppModel

    @MainActor
    func perform() async throws -> some IntentResult {
      model.syncSession()
      try await QuickPlay(session: model.session).playFavorites()
      return .result()
    }
  #endif
}

/// "Feeling lucky": Home's button, 15 songs put together now from one that suits the hour, new every time.
struct FeelingLuckyIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Feeling lucky"
  static let description = IntentDescription("Plays 15 songs put together for this hour, new every time.")

  #if WIDGET_EXTENSION
    func perform() async throws -> some IntentResult { .result() }
  #else
    @Dependency private var model: AppModel

    @MainActor
    func perform() async throws -> some IntentResult {
      model.syncSession()
      try await QuickPlay(session: model.session).feelingLucky()
      return .result()
    }
  #endif
}

/// "Start radio from the current song": the song playing, then songs like it.
struct StartRadioIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Start radio from the current song"
  static let description = IntentDescription("Plays songs like the one playing.")

  #if WIDGET_EXTENSION
    func perform() async throws -> some IntentResult { .result() }
  #else
    @Dependency private var model: AppModel

    @MainActor
    func perform() async throws -> some IntentResult {
      model.syncSession()
      try await QuickPlay(session: model.session).startRadio()
      return .result()
    }
  #endif
}
