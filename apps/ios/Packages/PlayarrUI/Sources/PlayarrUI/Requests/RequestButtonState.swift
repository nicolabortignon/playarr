import PlayarrAPI

/// What a Request button shows for an album that may not be in the library yet: one control for every state,
/// Request → Requesting… → Searching → 42% → Importing → In library (components/Discover.tsx, RequestButton). Pending
/// verbs end with an ellipsis, and every retry is "Try again" (docs/design.md, "Words").
public enum RequestButtonState: Equatable, Sendable {
  /// Nothing can be asked for (no Lidarr, requests off, or the account may not request) and nothing is on its way.
  case hidden
  /// Asking the server; `slow` after 2 s ("Looking up…").
  case requesting(slow: Bool)
  /// Some of its songs are here: "3/12" (or "3 here") opening the album, and Request for the rest when allowed.
  case partial(count: String, summary: String, albumId: Int?, canRequest: Bool)
  case request
  case searching(message: String?)
  case downloading(percent: Int, message: String?)
  case importing(message: String?)
  /// Monitored in Lidarr, nothing found yet: ask Lidarr to search again.
  case searchAgain(message: String?)
  case retry(message: String?)
  case inLibrary(albumId: Int?)

  public static func make(_ availability: Availability, allowed: Bool, pending: PendingRequest?) -> RequestButtonState {
    if let pending { return .requesting(slow: pending == .lookingUp) }
    switch availability.state {
    case .available:
      return .inLibrary(albumId: availability.albumId)
    case .partial:
      let have = availability.have ?? 0
      // How long the album is may be unknown (folder files without a track total): then just how many are here.
      if let total = availability.total, total > 0 {
        return .partial(count: "\(have)/\(total)", summary: "\(have) of \(total) songs in your library", albumId: availability.albumId, canRequest: allowed)
      }
      return .partial(count: "\(have) here", summary: "\(Format.plural(have, "song")) in your library", albumId: availability.albumId, canRequest: allowed)
    case .searching:
      return .searching(message: availability.message)
    case .downloading:
      return .downloading(percent: Int(Format.jsRound((availability.progress ?? 0) * 100)), message: availability.message)
    case .importing:
      return .importing(message: availability.message)
    case .waiting:
      return allowed ? .searchAgain(message: availability.message) : .hidden
    case .failed:
      return allowed ? .retry(message: availability.message) : .hidden
    case .noneValue, .unknown:
      return allowed ? .request : .hidden
    }
  }

  /// The button's words.
  public var label: String {
    switch self {
    case .hidden: ""
    case .requesting(let slow): slow ? "Looking up…" : "Requesting…"
    case .partial(let count, _, _, _): count
    case .request: "Request"
    case .searching: "Searching"
    case .downloading(let percent, _): "\(percent)%"
    case .importing: "Importing"
    case .searchAgain, .retry: "Try again"
    case .inLibrary: "In library"
    }
  }

  /// The words as a partly-here album's own action in its action row, where what's asked for is the rest of it.
  public var restLabel: String { self == .request ? "Request the rest" : label }

  /// The web's tooltip: Lidarr's message, or why it's slow.
  public var help: String? {
    switch self {
    case .requesting(true): "Finding this album on MusicBrainz, which answers about one request per second"
    case .partial(_, let summary, _, _): summary
    case .searching(let message), .importing(let message), .searchAgain(let message), .retry(let message): message
    case .downloading(_, let message): message
    default: nil
    }
  }

  /// Pressing it asks Lidarr for the album (the partial state's second button does too).
  public var asks: Bool {
    switch self {
    case .request, .searchAgain, .retry: true
    default: false
    }
  }

  /// Pressing it opens the album in the library.
  public var opensAlbum: Int? {
    switch self {
    case .inLibrary(let id), .partial(_, _, let id, _): id
    default: nil
    }
  }
}
