import Foundation
import PlayarrAPI

/// Feeling lucky's next press, made ready once one looks likely (apps/web/src/components/LuckyButton.tsx `getNext`,
/// `takeNext`): a finger touching the button, the pointer coming over it, or it taking the focus. Its songs are asked
/// for and the covers the fan will deal start loading, so at the press the first song's cover is usually there, the fan
/// deals it in the same rhythm as the rest, and the music starts at once. Kept two minutes; a press takes it, and the one
/// after asks afresh. One per account, on its session, so what one account asked for never plays for another.
@MainActor
final class NextLucky {
  /// A press made ready: its songs on their way, and the covers at hand to deal while they come.
  struct Next {
    let at: Date
    let answer: Task<LuckyMix, any Error>
    let hand: [FanCover]
    /// Which ask it is.
    fileprivate let ask: Int
  }

  /// How long what was asked ahead is kept (the web's `NEXT_KEPT_MS`).
  static let keptFor: TimeInterval = 2 * 60
  /// Covers at hand to look through, and how many of them are dealt before the first song's (`AT_HAND`, `IN_HAND`).
  static let atHand = 8
  static let inHand = 4
  /// The size the fan asks its covers at, in pixels (`FAN_ART`: they're 60 points, or 44).
  static let fanArt = 96

  /// Loads a cover's picture at the fan's size: true once it's there, false when there's none. The image cache's;
  /// tests stand in their own.
  var picture: @MainActor (FanCover) async -> Bool

  private let api: any APISending
  private let queries: QueryCache
  private let now: () -> Date
  private var next: Next?
  private var asks = 0
  /// The covers whose pictures are in, and those on their way.
  private var loaded: Set<String> = []
  private var loading: [String: Task<Bool, Never>] = [:]

  init(api: any APISending, queries: QueryCache, images: ImageCache, now: @escaping () -> Date = Date.init) {
    self.api = api
    self.queries = queries
    self.now = now
    picture = { cover in await images.data(cover.path, size: Self.fanArt) != nil }
  }

  /// The next press, made ready if it isn't (or what was is more than two minutes old). `still` (Reduce Motion): no fan,
  /// so no covers at hand.
  @discardableResult
  func get(still: Bool) -> Next {
    if let next, now().timeIntervalSince(next.at) < Self.keptFor { return next }
    asks += 1
    let ask = asks
    let api = self.api
    let answer = Task {
      do {
        let mix = try await api.send(API.Mixes.lucky())
        // The covers it will deal from the songs it found, as soon as they're known.
        for cover in FanCover.fan(mix.tracks) { load(cover) }
        return mix
      } catch {
        // Failed: the press asks again.
        if next?.ask == ask { next = nil }
        throw error
      }
    }
    let ready = Next(at: now(), answer: answer, hand: still ? [] : coversAtHand(), ask: ask)
    next = ready
    // The spare too, in case it stands in for a card showing the first song's album.
    for cover in ready.hand.prefix(Self.inHand + 1) { load(cover) }
    return ready
  }

  /// The press: what was made ready (or made now), which the next press won't see again.
  func take(still: Bool) -> Next {
    let taken = get(still: still)
    next = nil
    return taken
  }

  /// The cover's picture is in: the fan deals only covers whose are.
  func isLoaded(_ cover: FanCover) -> Bool {
    loaded.contains(cover.key)
  }

  /// Waits for the covers' pictures, loading those not on their way: `limit` at most (the web's `pictureOf(c, ms)`).
  func waitForPictures(_ covers: [FanCover], upTo limit: Duration, clock: any Clock<Duration>) async {
    for cover in covers { load(cover) }
    let pending = covers.compactMap { loading[$0.key] }
    guard !pending.isEmpty else { return }
    // Whichever comes first, the pictures or the time; the pictures go on loading either way.
    let first = First()
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
      first.continuation = done
      let timer = Task {
        try? await clock.sleep(for: limit)
        first.resume()
      }
      Task {
        for picture in pending { _ = await picture.value }
        timer.cancel()
        first.resume()
      }
    }
  }

  /// Covers at hand to deal while it picks: albums already loaded (Home's shelves, Albums, Jump back in, kept from the
  /// last visit), each once, shuffled; none when nothing is loaded yet (the web's `coversAtHand`).
  func coversAtHand() -> [FanCover] {
    var seen = Set<String>()
    var covers: [FanCover] = []
    for albums in queries.values(named: ["albums", "recent-albums"], as: [Album].self) {
      for album in albums {
        guard let path = album.coverUrl, seen.insert(path).inserted else { continue }
        covers.append(FanCover(album: album))
      }
    }
    return Array(covers.shuffled().prefix(Self.atHand))
  }

  /// Starts loading a cover's picture, unless it's in or on its way.
  private func load(_ cover: FanCover) {
    guard !loaded.contains(cover.key), loading[cover.key] == nil else { return }
    let key = cover.key
    loading[key] = Task {
      let there = await picture(cover)
      if there { loaded.insert(key) }
      loading[key] = nil
      return there
    }
  }
}

/// A continuation resumed once, by whichever of its callers comes first.
@MainActor
private final class First {
  var continuation: CheckedContinuation<Void, Never>?

  func resume() {
    continuation?.resume()
    continuation = nil
  }
}

/// A cover in Feeling lucky's fan (the web's `FanCover`): its picture, and its color while that loads.
struct FanCover: Hashable, Sendable {
  /// One per album: its cover's address, else the album.
  let key: String
  let path: String?
  /// The cover's own color, `#rrggbb` (`coverColor`).
  let color: String?

  init(album: Album) {
    key = album.coverUrl ?? "album:\(album.id)"
    path = album.coverUrl
    color = album.coverColor
  }

  init(track: Track) {
    key = track.coverUrl ?? "album:\(track.albumId)"
    path = track.coverUrl
    color = track.coverColor
  }

  /// The covers to deal from the songs it found: up to three of the others' albums, each once, then the first song's
  /// (the web's `fanCovers`).
  static func fan(_ tracks: [Track]) -> [FanCover] {
    guard let first = tracks.first else { return [] }
    let landing = FanCover(track: first)
    var others: [FanCover] = []
    for track in tracks.dropFirst() {
      let cover = FanCover(track: track)
      if cover.key != landing.key, !others.contains(where: { $0.key == cover.key }) { others.append(cover) }
      if others.count == 3 { break }
    }
    return others + [landing]
  }
}
