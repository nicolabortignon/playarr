import AppIntents
import PlayarrUI

/// "Play my Favorites": the Favorites page's Play, from Siri, Shortcuts, Spotlight or the Action button. An audio
/// playback intent, so it plays without bringing the app to the front.
struct PlayFavoritesIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Play my Favorites"
  static let description = IntentDescription("Plays your Favorites in order.")

  @Dependency private var model: AppModel

  @MainActor
  func perform() async throws -> some IntentResult {
    model.syncSession()
    try await QuickPlay(session: model.session).playFavorites()
    return .result()
  }
}

/// "Feeling lucky": Home's button, 15 songs put together now from one that suits the hour, new every time.
struct FeelingLuckyIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Feeling lucky"
  static let description = IntentDescription("Plays 15 songs put together for this hour, new every time.")

  @Dependency private var model: AppModel

  @MainActor
  func perform() async throws -> some IntentResult {
    model.syncSession()
    try await QuickPlay(session: model.session).feelingLucky()
    return .result()
  }
}

/// "Start radio from the current song": the song playing, then songs like it.
struct StartRadioIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Start radio from the current song"
  static let description = IntentDescription("Plays songs like the one playing.")

  @Dependency private var model: AppModel

  @MainActor
  func perform() async throws -> some IntentResult {
    model.syncSession()
    try await QuickPlay(session: model.session).startRadio()
    return .result()
  }
}
