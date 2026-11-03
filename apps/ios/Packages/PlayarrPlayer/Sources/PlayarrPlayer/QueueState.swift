import PlayarrAPI

public enum RepeatMode: String, Codable, Sendable { case off, all, one }

/// What the queue was started from (an album, a mix, a playlist…), for "Playing from".
public struct PlaySource: Codable, Sendable, Hashable {
  public var label: String
  public var href: String
  public init(label: String, href: String) {
    self.label = label
    self.href = href
  }
}

/// The queue, as `usePlayer` in apps/web/src/player/store.ts: songs in the order added, the play order as indices
/// into them, and the position in that order. Every rule below is ported from there, test by test.
public struct QueueState: Codable, Sendable, Equatable {
  /// Tracks in the order they were added.
  public var queue: [Track] = []
  /// Play order: indices into `queue` (identity unless shuffled).
  public var order: [Int] = []
  /// Position within `order` of the current track, -1 when empty.
  public var pos = -1
  public var shuffle = false
  public var repeatMode: RepeatMode = .off
  public var volume: Double = 1
  public var muted = false
  /// Where to resume after a relaunch.
  public var resumeAt: Double = 0
  /// What the queue was started from; unset, Now Playing shows the song's album.
  public var source: PlaySource?
  /// How this queue is mixed when transitions are DJ mix.
  public var mixMode: MixMode = .auto

  // Not persisted:
  public var playing = false
  /// Bumped to ask the engine to restart the current track (e.g. "previous" near the start).
  public var restartToken = 0
  /// Where the engine starts the song it loads next, once (then nil).
  public var startAt: Double?

  public init() {}

  // MARK: Reading

  public var currentTrack: Track? {
    order.indices.contains(pos) ? queue[order[pos]] : nil
  }

  /// The song a press of Next goes to (repeat one included: Next leaves the song), if any.
  public var nextByPress: Track? {
    guard pos >= 0 else { return nil }
    if pos + 1 < order.count { return queue[order[pos + 1]] }
    return repeatMode == .all && !order.isEmpty ? queue[order[0]] : nil
  }

  /// The song that plays when this one ends on its own; none with repeat one (the song restarts).
  public var upNext: Track? {
    guard pos >= 0, repeatMode != .one else { return nil }
    if pos + 1 < order.count { return queue[order[pos + 1]] }
    return repeatMode == .all && order.count > 1 ? queue[order[0]] : nil
  }

  /// Where `upNext` is in `queue`.
  public var upNextIndex: Int? {
    guard upNext != nil else { return nil }
    return pos + 1 < order.count ? order[pos + 1] : order[0]
  }

  /// The songs after the current one in play order, at most `count` (round to the first with repeat all).
  public func upcoming(_ count: Int) -> [Track] {
    guard pos >= 0, count > 0 else { return [] }
    let after = order.dropFirst(pos + 1) + (repeatMode == .all ? order.prefix(pos) : [])
    return after.prefix(count).map { queue[$0] }
  }

  // MARK: Changing

  /// `at`: start the song there (seconds) instead of its beginning.
  public mutating func playTracks(_ tracks: [Track], startIndex: Int = 0, shuffle: Bool? = nil, source: PlaySource? = nil, at: Double? = nil) {
    var rng = SystemRandomNumberGenerator()
    playTracks(tracks, startIndex: startIndex, shuffle: shuffle, source: source, at: at, using: &rng)
  }

  public mutating func playTracks(
    _ tracks: [Track], startIndex: Int = 0, shuffle: Bool? = nil, source: PlaySource? = nil, at: Double? = nil,
    using rng: inout some RandomNumberGenerator
  ) {
    guard !tracks.isEmpty else { return }
    let shuffled = shuffle ?? self.shuffle
    let start = shuffle == true ? Int.random(in: 0..<tracks.count, using: &rng) : startIndex
    queue = tracks
    order = shuffled ? [start] + Array(0..<tracks.count).filter { $0 != start }.shuffled(using: &rng) : Array(0..<tracks.count)
    pos = shuffled ? 0 : start
    self.shuffle = shuffled
    self.source = source
    // A party mode picked for the last queue shouldn't carry over to something new.
    mixMode = .auto
    playing = true
    resumeAt = 0
    startAt = at
    restartToken += 1
  }

  public mutating func playNext(_ tracks: [Track]) {
    guard pos >= 0 else { return playTracks(tracks) }
    let base = queue.count
    queue += tracks
    order = Array(order.prefix(pos + 1)) + tracks.indices.map { base + $0 } + Array(order.dropFirst(pos + 1))
  }

  public mutating func addToQueue(_ tracks: [Track]) {
    guard pos >= 0 else { return playTracks(tracks) }
    let base = queue.count
    queue += tracks
    order += tracks.indices.map { base + $0 }
  }

  public mutating func jumpTo(_ orderPos: Int, at: Double? = nil) {
    guard order.indices.contains(orderPos) else { return }
    pos = orderPos
    playing = true
    resumeAt = 0
    startAt = at
    restartToken += 1
  }

  public mutating func removeAt(_ orderPos: Int) {
    guard orderPos != pos, order.indices.contains(orderPos) else { return }
    // Leave the track in `queue` (indices stay valid); just drop it from the play order.
    order.remove(at: orderPos)
    if orderPos < pos { pos -= 1 }
  }

  public mutating func move(from fromPos: Int, to toPos: Int) {
    guard fromPos != toPos, order.indices.contains(fromPos), order.indices.contains(toPos) else { return }
    let current = order[pos]
    let item = order.remove(at: fromPos)
    order.insert(item, at: toPos)
    pos = order.firstIndex(of: current) ?? pos
  }

  /// Replace what plays after the current song: indices into `queue`, e.g. reordered or restored.
  public mutating func setUpcoming(_ queueIndices: [Int]) {
    let current = order.indices.contains(pos) ? order[pos] : nil
    let valid = queueIndices.filter { queue.indices.contains($0) && $0 != current }
    order = Array(order.prefix(pos + 1)) + valid
  }

  public mutating func clearUpcoming() {
    order = Array(order.prefix(pos + 1))
  }

  /// On to the next song: `auto` when the song ended (or the engine moved on); a press of Next otherwise.
  public mutating func next(auto: Bool = false) {
    guard auto else { return _ = moveOn() }
    if repeatMode == .one {
      restartToken += 1
      resumeAt = 0
      return
    }
    // End of queue: stop at the last track.
    if !moveOn() {
      playing = false
      resumeAt = 0
      restartToken += 1
    }
  }

  /// Restarts the song if past 3 s (or at the first song without repeat all), else goes back one.
  public mutating func prev(currentTime: Double) {
    if currentTime > 3 || (pos == 0 && repeatMode != .all) {
      restartToken += 1
      resumeAt = 0
      return
    }
    pos = pos > 0 ? pos - 1 : order.count - 1
    playing = true
    resumeAt = 0
  }

  public mutating func toggle() {
    if pos >= 0 { playing.toggle() }
  }

  public mutating func toggleShuffle() {
    var rng = SystemRandomNumberGenerator()
    toggleShuffle(using: &rng)
  }

  public mutating func toggleShuffle(using rng: inout some RandomNumberGenerator) {
    guard pos >= 0 else { return shuffle.toggle() }
    let current = order[pos]
    if !shuffle {
      // Keep history, shuffle only what's upcoming.
      order = Array(order.prefix(pos + 1)) + order.dropFirst(pos + 1).shuffled(using: &rng)
      shuffle = true
    } else {
      // Restore the queue's order, continuing from the current track.
      let kept = Set(order)
      order = queue.indices.filter { kept.contains($0) }
      pos = order.firstIndex(of: current) ?? 0
      shuffle = false
    }
  }

  /// Off → all → one → off.
  public mutating func cycleRepeat() {
    repeatMode = switch repeatMode {
    case .off: .all
    case .all: .one
    case .one: .off
    }
  }

  public mutating func setVolume(_ v: Double) {
    volume = min(1, max(0, v))
    muted = false
  }

  private mutating func moveOn() -> Bool {
    if pos + 1 < order.count {
      pos += 1
    } else if repeatMode == .all && !order.isEmpty {
      pos = 0
    } else {
      return false
    }
    playing = true
    resumeAt = 0
    return true
  }

  // MARK: Saving

  private enum CodingKeys: String, CodingKey {
    case queue, order, pos, shuffle, repeatMode = "repeat", volume, muted, resumeAt, source, mixMode
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    queue = try c.decodeIfPresent([Track].self, forKey: .queue) ?? []
    order = try c.decodeIfPresent([Int].self, forKey: .order) ?? []
    pos = try c.decodeIfPresent(Int.self, forKey: .pos) ?? -1
    shuffle = try c.decodeIfPresent(Bool.self, forKey: .shuffle) ?? false
    repeatMode = (try? c.decodeIfPresent(RepeatMode.self, forKey: .repeatMode)) ?? .off
    volume = try c.decodeIfPresent(Double.self, forKey: .volume) ?? 1
    muted = try c.decodeIfPresent(Bool.self, forKey: .muted) ?? false
    resumeAt = try c.decodeIfPresent(Double.self, forKey: .resumeAt) ?? 0
    source = try c.decodeIfPresent(PlaySource.self, forKey: .source)
    // A mix mode this version doesn't know (or none, from before mixing) plays as Auto.
    let mode = try c.decodeIfPresent(MixMode.self, forKey: .mixMode) ?? .auto
    mixMode = MixMode.allCases.contains(mode) ? mode : .auto
    // A queue whose indices don't fit its songs (a damaged file) starts empty rather than crash.
    if order.contains(where: { !queue.indices.contains($0) }) || (pos != -1 && !order.indices.contains(pos)) {
      self = QueueState()
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(queue, forKey: .queue)
    try c.encode(order, forKey: .order)
    try c.encode(pos, forKey: .pos)
    try c.encode(shuffle, forKey: .shuffle)
    try c.encode(repeatMode, forKey: .repeatMode)
    try c.encode(volume, forKey: .volume)
    try c.encode(muted, forKey: .muted)
    try c.encode(resumeAt, forKey: .resumeAt)
    try c.encodeIfPresent(source, forKey: .source)
    try c.encode(mixMode, forKey: .mixMode)
  }
}
