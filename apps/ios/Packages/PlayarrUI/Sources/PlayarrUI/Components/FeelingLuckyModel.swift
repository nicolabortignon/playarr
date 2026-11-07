import Foundation

/// What Feeling lucky's press does (apps/web/src/components/LuckyButton.tsx `LuckyButton`): it takes the songs asked for
/// ahead (`NextLucky`), or asks for them then, and plays them as soon as they're back; meanwhile the fan deals covers
/// from behind the button (`CoverFan`). It waits a moment for the songs, so every card goes out in one rhythm; past that
/// the covers at hand go out, and the first song's follows once it's known. The music never waits for the fan.
@MainActor @Observable
final class FeelingLuckyModel {
  /// How long the fan waits for the songs before dealing the covers at hand, and for the first song's picture
  /// (`WAIT_MS`, `PICTURE_WAIT_MS`).
  static let waitForSongs = Duration.milliseconds(300)
  static let waitForPicture = Duration.milliseconds(300)

  /// The songs are being picked: the sparkles twinkle.
  private(set) var picking = false
  /// What the fan is dealing; nil when it's not out.
  private(set) var deal: FanDeal?
  /// Each press deals afresh.
  private(set) var presses = 0

  @ObservationIgnored private let clock: any Clock<Duration>

  init(clock: any Clock<Duration> = ContinuousClock()) {
    self.clock = clock
  }

  /// A press looks likely (a finger touches the button, the pointer comes over it, or it takes the focus): the songs
  /// are asked for, and the covers to deal start loading.
  func prepare(_ session: AccountSession, still: Bool) {
    session.nextLucky.get(still: still)
  }

  /// The press. `still` (Reduce Motion): no fan; the sparkles say it's picking, and the music starting says what it
  /// found. A press while it's picking does nothing.
  func press(_ session: AccountSession, still: Bool) async {
    guard !picking else { return }
    let lucky = session.nextLucky
    let next = lucky.take(still: still)
    let hand = still ? [] : next.hand
    picking = true
    presses += 1
    deal = nil
    defer { picking = false }
    let wait: Task<Void, any Error>? =
      hand.isEmpty
      ? nil
      : Task { [clock] in
        try await clock.sleep(for: Self.waitForSongs)
        try Task.checkCancellation()
        deal = Self.atHand(hand, lucky)
      }
    let covers = FanCover.fan(await QuickPlay.feelingLucky(session: session, mix: next.answer))
    let landing = covers.last
    // Its picture first, so it doesn't come out blank; with nothing at hand to deal, the others' too, dealt instead.
    if let landing, !still {
      let atHand = deal ?? Self.atHand(hand, lucky)
      await lucky.waitForPictures(atHand == nil ? covers : [landing], upTo: Self.waitForPicture, clock: clock)
    }
    wait?.cancel()
    // It found nothing (and has said so): the cards out go back.
    guard let landing else {
      deal = deal?.allDealt
      return
    }
    guard !still else { return }
    // Without covers at hand (nothing loaded yet), a few of the songs it found are dealt instead.
    let found = covers.dropLast().filter { lucky.isLoaded($0) }
    deal = (deal ?? Self.atHand(hand, lucky) ?? FanDeal(cards: found, slots: found.count + 1)).with(landing: landing)
  }

  /// The covers at hand whose pictures are in, as they go out: four of them, the rest spares, and a place for the first
  /// song's; nil when none are in.
  private static func atHand(_ hand: [FanCover], _ lucky: NextLucky) -> FanDeal? {
    let ready = hand.filter { lucky.isLoaded($0) }
    let cards = Array(ready.prefix(NextLucky.inHand))
    guard !cards.isEmpty else { return nil }
    return FanDeal(cards: cards, spares: Array(ready.dropFirst(NextLucky.inHand)), slots: cards.count + 1)
  }

  /// The fan dealt for press `press` has gone back behind the button.
  func dealt(press: Int) {
    if press == presses { deal = nil }
  }
}

/// The covers being dealt (the web's `Deal`): those at hand while it picks, with spares, then the first song's once it's
/// known, last and on top; `slots`, how many in all, so each card's place in the fan is known from the start. `done`
/// once nothing more is coming (it found nothing, or failed), so the cards out go back.
struct FanDeal: Equatable, Sendable {
  var cards: [FanCover]
  var spares: [FanCover] = []
  var slots: Int
  var landing: FanCover?
  var done = false

  /// Every card, in the order dealt: the first song's last.
  var all: [FanCover] { cards + (landing.map { [$0] } ?? []) }

  /// Nothing more is coming (the web's `allDealt`).
  var allDealt: FanDeal {
    var deal = self
    deal.done = true
    return deal
  }

  /// The first song's cover joins the deal; a card at hand showing the same album gives way to a spare (the web's
  /// `withLanding`).
  func with(landing: FanCover) -> FanDeal {
    var deal = self
    deal.landing = landing
    guard let twin = cards.firstIndex(where: { $0.key == landing.key }), let spare = spares.first else { return deal }
    deal.cards[twin] = spare
    deal.spares.removeFirst()
    return deal
  }
}
