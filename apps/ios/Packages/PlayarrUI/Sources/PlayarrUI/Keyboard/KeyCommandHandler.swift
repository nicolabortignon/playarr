import PlayarrAPI

/// What each shortcut does, as the web's: ←/→ 10 s within the song, Shift for the previous or next song, ↑/↓ the
/// volume by 5 %, L the song playing in or out of Favorites, / to Search. Without a song only the volume, mute,
/// shuffle and Search do anything.
@MainActor
public struct KeyCommandHandler {
  public static let seekStep: Double = 10
  public static let volumeStep: Double = 0.05

  let controls: any PlaybackControlling
  let toggleFavorite: @MainActor (Track) -> Void
  let openSearch: @MainActor () -> Void

  public init(controls: any PlaybackControlling, toggleFavorite: @escaping @MainActor (Track) -> Void, openSearch: @escaping @MainActor () -> Void) {
    self.controls = controls
    self.toggleFavorite = toggleFavorite
    self.openSearch = openSearch
  }

  public init(session: AccountSession) {
    self.init(controls: session.player, toggleFavorite: { session.toggleFavorite($0) }, openSearch: { session.router.openSearch() })
  }

  public func perform(_ command: KeyCommand) {
    switch command {
    case .volumeUp: setVolume(controls.masterVolume + Self.volumeStep)
    case .volumeDown: setVolume(controls.masterVolume - Self.volumeStep)
    case .mute: controls.toggleMute()
    case .shuffle: controls.toggleShuffle()
    case .search: openSearch()
    case .playPause, .seekBack, .seekForward, .previous, .next, .favorite:
      guard let song = controls.song else { return }
      switch command {
      case .playPause: controls.togglePlay()
      case .seekBack: controls.seek(to: max(0, controls.time - Self.seekStep))
      case .seekForward: controls.seek(to: min(controls.duration, controls.time + Self.seekStep))
      case .previous: controls.previous()
      case .next: controls.next()
      default: toggleFavorite(song)
      }
    }
  }

  /// In steps of 1 %, between silent and full.
  private func setVolume(_ volume: Double) {
    controls.setVolume(min(1, max(0, (volume * 100).rounded() / 100)))
  }
}
