import PlayarrPlayer

/// What a page's Play button says (docs/design.md, "The action row"): Play, or Pause and Resume while the queue is
/// the page's own, so the button pauses and resumes it rather than starting it again.
enum PlayState: CaseIterable, Sendable {
  case stopped, playing, paused

  init(isCurrent: Bool, playing: Bool) {
    self = isCurrent ? (playing ? .playing : .paused) : .stopped
  }

  /// The page at `href` ("/playlists/3") started the queue, which still has a song.
  static func of(_ queue: QueueState, href: String) -> PlayState {
    PlayState(isCurrent: queue.currentTrack != nil && queue.source?.href == href, playing: queue.playing)
  }

  /// The queue is the page's: Play pauses or resumes it.
  var isCurrent: Bool { self != .stopped }

  var label: String {
    switch self {
    case .stopped: "Play"
    case .playing: "Pause"
    case .paused: "Resume"
    }
  }

  var systemImage: String { self == .playing ? "pause.fill" : "play.fill" }
}
