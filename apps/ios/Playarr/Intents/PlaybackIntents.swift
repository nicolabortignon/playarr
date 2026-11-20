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

/// A widget's Jump back in: an album from the start. Not offered in Shortcuts (it'd ask for an album's id).
struct PlayAlbumIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Play an album"
  static let description = IntentDescription("Plays an album from the start.")
  static let isDiscoverable = false

  @Parameter(title: "Album") var albumId: Int

  init() {}

  init(albumId: Int) {
    self.albumId = albumId
  }

  #if WIDGET_EXTENSION
    func perform() async throws -> some IntentResult { .result() }
  #else
    @Dependency private var model: AppModel

    @MainActor
    func perform() async throws -> some IntentResult {
      model.syncSession()
      try await QuickPlay(session: model.session).playAlbum(albumId)
      return .result()
    }
  #endif
}

/// A widget's Made for you: a mix from the start. Not offered in Shortcuts (it'd ask for a mix's key).
struct PlayMixIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Play a mix"
  static let description = IntentDescription("Plays a Made for you mix from the start.")
  static let isDiscoverable = false

  @Parameter(title: "Mix") var mixKey: String

  init() {}

  init(mixKey: String) {
    self.mixKey = mixKey
  }

  #if WIDGET_EXTENSION
    func perform() async throws -> some IntentResult { .result() }
  #else
    @Dependency private var model: AppModel

    @MainActor
    func perform() async throws -> some IntentResult {
      model.syncSession()
      try await QuickPlay(session: model.session).playMix(mixKey)
      return .result()
    }
  #endif
}

/// The Now Playing widget's play and pause.
struct PlayPauseIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Play or pause"
  static let description = IntentDescription("Pauses the song playing, or plays it again.")
  static let isDiscoverable = false

  #if WIDGET_EXTENSION
    func perform() async throws -> some IntentResult { .result() }
  #else
    @Dependency private var model: AppModel

    @MainActor
    func perform() async throws -> some IntentResult {
      model.syncSession()
      try QuickPlay(session: model.session).togglePlay()
      return .result()
    }
  #endif
}

/// The Now Playing widget's next song.
struct NextSongIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Next song"
  static let description = IntentDescription("Skips to the next song.")
  static let isDiscoverable = false

  #if WIDGET_EXTENSION
    func perform() async throws -> some IntentResult { .result() }
  #else
    @Dependency private var model: AppModel

    @MainActor
    func perform() async throws -> some IntentResult {
      model.syncSession()
      try QuickPlay(session: model.session).next()
      return .result()
    }
  #endif
}

/// The Now Playing widget's previous song (or the start of this one, as the player's own button).
struct PreviousSongIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Previous song"
  static let description = IntentDescription("Goes back to the song before, or to the start of this one.")
  static let isDiscoverable = false

  #if WIDGET_EXTENSION
    func perform() async throws -> some IntentResult { .result() }
  #else
    @Dependency private var model: AppModel

    @MainActor
    func perform() async throws -> some IntentResult {
      model.syncSession()
      try QuickPlay(session: model.session).previous()
      return .result()
    }
  #endif
}
