import PlayarrAPI
import PlayarrPlayer

/// The sleeve's tracklist (docs/ios/layouts.md): the song before the one playing, the
/// song playing, then the rest of the queue in play order, read like the back of a record. Lines are worked out on
/// demand (`line(at:)`), so a queue of thousands costs only the lines on screen.
public struct Tracklist: Equatable, Sendable {
  /// How one song becomes the next, drawn between their lines.
  public enum Join: Equatable, Sendable {
    /// Plain spacing.
    case none
    /// The next song on the same album, in order: heard as one, joined by a hairline.
    case continues
    /// Faded into each other over this many seconds.
    case crossfade(Int)
    /// DJ mix, the pair being prepared now: the transition in words.
    case dj
    /// DJ mix, a pair further down (only the next pair is known yet): a faint dotted joiner.
    case djLater
  }

  public enum State: Equatable, Sendable { case played, playing, upcoming }

  public struct Line: Equatable, Sendable, Identifiable {
    /// Its place in play order (what `Player.jump(to:)` takes).
    public let orderPos: Int
    public let track: Track
    public let state: State
    /// The record's track number ("4", "2-04") for an album played in order, else its place from the song playing
    /// ("1" is next); empty for the song before.
    public let number: String
    /// The artist, when it isn't the source's own (a playlist or mix shows it; an album doesn't).
    public let showsArtist: Bool
    /// The album, when it differs from the line above's (so a mix reads "Unfinished Sympathy · Blue Lines").
    public let showsAlbum: Bool
    /// How the line above becomes this one.
    public let joinBefore: Join

    public var id: Int { orderPos }
  }

  public let queue: QueueState
  public let transitions: PlaybackSettings.Transitions
  public let crossfade: Double
  public let autoplay: Bool

  public init(queue: QueueState, transitions: PlaybackSettings.Transitions, crossfade: Double, autoplay: Bool) {
    self.queue = queue
    self.transitions = transitions
    self.crossfade = crossfade
    self.autoplay = autoplay
  }

  /// The places in play order the list shows: from the song before the one playing to the end.
  public var range: Range<Int> {
    guard queue.pos >= 0, queue.pos < queue.order.count else { return 0..<0 }
    return max(0, queue.pos - 1)..<queue.order.count
  }

  /// An album played in order (from its page, not shuffled): lines carry the record's numbers.
  public var albumInOrder: Bool {
    !queue.shuffle && (queue.source?.href.hasPrefix("/albums/") ?? false)
  }

  /// Artists are left out when the source is one album or one artist.
  private var sourceIsOneArtist: Bool {
    guard let href = queue.source?.href else { return false }
    return href.hasPrefix("/albums/") || href.hasPrefix("/artists/")
  }

  /// The album played in order, by its id: songs radio adds after it are numbered by their place, not their record's.
  private var sourceAlbumId: Int? { albumInOrder ? sourceId : nil }

  /// The album's or artist's id in the source's address ("/albums/70" → 70).
  private var sourceId: Int? {
    queue.source.flatMap { Int($0.href.split(separator: "/").dropFirst().first?.prefix { $0.isNumber } ?? "") }
  }

  /// A song radio added after the album or artist the queue came from.
  private func fromElsewhere(_ track: Track) -> Bool {
    guard let href = queue.source?.href, let id = sourceId else { return false }
    if href.hasPrefix("/albums/") { return track.albumId != id }
    if href.hasPrefix("/artists/") { return track.artistId != id }
    return false
  }

  private var multiDisc: Bool { queue.queue.contains { $0.albumId == sourceAlbumId && $0.discNumber > 1 } }

  private func song(at orderPos: Int) -> Track? {
    guard orderPos >= 0, orderPos < queue.order.count else { return nil }
    let index = queue.order[orderPos]
    return index < queue.queue.count ? queue.queue[index] : nil
  }

  public func line(at orderPos: Int) -> Line? {
    guard let track = song(at: orderPos) else { return nil }
    let state: State = orderPos < queue.pos ? .played : orderPos == queue.pos ? .playing : .upcoming
    let above = song(at: orderPos - 1)
    return Line(
      orderPos: orderPos, track: track, state: state, number: number(track, at: orderPos, state: state),
      showsArtist: !sourceIsOneArtist || fromElsewhere(track),
      showsAlbum: (!albumInOrder || fromElsewhere(track)) && above?.albumId != track.albumId,
      joinBefore: orderPos > range.lowerBound ? join(above, track, at: orderPos) : .none)
  }

  private func number(_ track: Track, at orderPos: Int, state: State) -> String {
    if let album = sourceAlbumId, track.albumId == album {
      return multiDisc ? "\(track.discNumber)-\(track.trackNumber < 10 ? "0" : "")\(track.trackNumber)" : "\(track.trackNumber)"
    }
    return state == .upcoming ? "\(orderPos - queue.pos)" : ""
  }

  private func join(_ a: Track?, _ b: Track, at orderPos: Int) -> Join {
    guard let a else { return .none }
    if JoinRules.continues(a, b) { return .continues }
    switch transitions {
    case .dj: return orderPos == queue.pos + 1 ? .dj : orderPos > queue.pos + 1 ? .djLater : .none
    case .crossfade:
      let seconds = JoinRules.fadeSeconds(a, b, crossfade: crossfade)
      return seconds > 0 ? .crossfade(Int(seconds.rounded())) : .none
    case .off: return .none
    }
  }

  /// The quiet line after the last song.
  public var end: String {
    if queue.repeatMode == .all { return "Then from the top" }
    if autoplay { return "Then: more like these" }
    return "The queue ends here"
  }

  /// "7 songs · 38 min left", counting from the song playing, `elapsed` seconds into it.
  public func left(elapsed: Double) -> String? {
    guard queue.pos >= 0, queue.pos < queue.order.count else { return nil }
    let songs = queue.order.count - queue.pos
    let seconds = (queue.pos..<queue.order.count).reduce(0.0) { $0 + (song(at: $1)?.duration ?? 0) } - elapsed
    return "\(Format.plural(songs, "song")) · \(Format.duration(max(0, seconds))) left"
  }
}
