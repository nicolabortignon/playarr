import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

/// Feeling lucky's songs: the first from album 1, then albums 2, 2, 3, 4, 5 (apps/web/src/components/LuckyButton.test.tsx).
private let found = [(1, 1), (2, 2), (3, 2), (4, 3), (5, 4), (6, 5)].map { id, album in
  Demo.track(id, "Song \(id)", album: album, albumTitle: "Album \(album)", artist: Demo.artist, number: id, duration: 200)
}
private let foundIds = found.map(\.id)
/// Albums on Home's shelves, loaded before the press.
private let shelf = [20, 21, 22, 23].map(album)
private let shelfKeys = Set(shelf.compactMap(\.coverUrl))

private func album(_ id: Int) -> Album {
  Album(
    id: id, title: "Album \(id)", artistId: 7, artistName: "Massive Attack", albumType: "Album", secondaryTypes: [], genres: [],
    duration: 1000, trackCount: 4, totalTrackCount: 4, coverUrl: "/art/album/\(id)/cover", coverColor: "#405060")
}

private func cover(_ album: Int) -> String { "/art/album/\(album)/cover" }

@MainActor @Suite struct FeelingLuckyTests {
  /// A session whose Feeling lucky finds `found` (or `mix`), its pictures loading at once, with the shelf loaded unless
  /// said otherwise.
  private func session(_ api: FakeAPI = FakeAPI.demoLibrary(), mix: LuckyMix? = nil, shelved: Bool = true) -> AccountSession {
    api.on(.post, "/api/lucky", mix ?? LuckyMix(tracks: found, subtitle: "Evening: warm"))
    let session = demoSession(api: api)
    if shelved { session.queries.set(shelf, for: .albums(.added, limit: 14)) }
    session.nextLucky.picture = { _ in true }
    return session
  }

  private func asked(_ api: FakeAPI) -> Int { api.calls(.post, "/api/lucky").count }

  /// Waits until the shelf's pictures are in.
  private func shelfLoaded(_ session: AccountSession) async {
    while !shelf.allSatisfy({ session.nextLucky.isLoaded(FanCover(album: $0)) }) { await Task.yield() }
  }

  @Test func coversAtHandAreTheAlbumsAlreadyLoadedEachOnce() {
    let session = session()
    var noArt = album(31)
    noArt.coverUrl = nil
    session.queries.set([shelf[0], album(30), noArt], for: .recentAlbums)
    #expect(Set(session.nextLucky.coversAtHand().map(\.key)) == shelfKeys.union([cover(30)]))
    #expect(session.nextLucky.coversAtHand().first { $0.key == cover(20) }?.color == "#405060")
    #expect(demoSession(api: FakeAPI()).nextLucky.coversAtHand().isEmpty)
  }

  @Test func withNothingLoadedTheSongsItFoundAreDealtTheFirstSongsLast() {
    #expect(FanCover.fan(found).map(\.key) == [cover(2), cover(3), cover(4), cover(1)])
    #expect(FanCover.fan(Array(found.prefix(3))).map(\.key) == [cover(2), cover(1)])
    #expect(FanCover.fan([]).isEmpty)
  }

  @Test func asksOnceAsAPressLooksLikelySoTheFirstSongsCoverGoesOutInOneRhythm() async throws {
    let api = FakeAPI.demoLibrary()
    let session = session(api)
    let model = FeelingLuckyModel(clock: TestClock())
    // A finger touching it, the pointer coming over it, it taking the focus: one ask.
    model.prepare(session, still: false)
    model.prepare(session, still: false)
    model.prepare(session, still: false)
    _ = try? await session.nextLucky.get(still: false).answer.value
    #expect(asked(api) == 1)
    await shelfLoaded(session)
    await model.press(session, still: false)
    // All five from the start: the covers at hand, then the first song's, last and on top.
    let deal = try #require(model.deal)
    #expect(Set(deal.cards.map(\.key)) == shelfKeys)
    #expect(deal.slots == 5)
    #expect(deal.all.last?.key == cover(1))
    #expect(session.player.queue.queue.map(\.id) == foundIds)
    #expect(asked(api) == 1)
    #expect(!model.picking)
    // The fan went back behind the button.
    model.dealt(press: model.presses)
    #expect(model.deal == nil)
  }

  @Test func aPressWithoutOneAsksThenAndTheNextAsksAfresh() async {
    let api = FakeAPI.demoLibrary()
    let session = session(api)
    let model = FeelingLuckyModel(clock: TestClock())
    await model.press(session, still: false)
    #expect(asked(api) == 1)
    #expect(session.player.queue.queue.map(\.id) == foundIds)
    await model.press(session, still: false)
    #expect(asked(api) == 2)
  }

  @Test func keepsWhatWasAskedAheadTwoMinutes() async {
    var now = Date(timeIntervalSince1970: 1_800_000_000)
    let session = session()
    let lucky = NextLucky(api: session.api, queries: session.queries, images: session.images) { now }
    let first = lucky.get(still: false)
    now += 119
    #expect(lucky.get(still: false).answer == first.answer)
    now += 2
    let second = lucky.get(still: false)
    #expect(second.answer != first.answer)
    // A press takes it: the next asks afresh.
    #expect(lucky.take(still: false).answer == second.answer)
    #expect(lucky.get(still: false).answer != second.answer)
  }

  @Test func whatOneAccountAskedForNeverPlaysForAnother() async throws {
    let api = FakeAPI.demoLibrary()
    api.on(.post, "/api/lucky", LuckyMix(tracks: found, subtitle: "Evening: warm"))
    let model = demoModel(api: api)
    let demo = try #require(model.session)
    FeelingLuckyModel().prepare(demo, still: false)
    _ = try? await demo.nextLucky.get(still: false).answer.value
    let sam = Account(id: 2, username: "sam", name: "Sam", role: .member, canRequest: false, sources: nil, hasPassword: true)
    try model.store.signedIn(SignInResponse(token: "t2", account: sam), server: Demo.server, at: Demo.baseURL)
    model.syncSession()
    let session = try #require(model.session)
    session.nextLucky.picture = { _ in true }
    await FeelingLuckyModel(clock: TestClock()).press(session, still: false)
    #expect(asked(api) == 2)
  }

  @Test func aFailedAskIsAskedAgainAtThePress() async {
    let api = FakeAPI.demoLibrary()
    let session = session(api)
    api.fail(.post, "/api/lucky", status: 500, "Lidarr is down")
    let model = FeelingLuckyModel(clock: TestClock())
    // As a press looks likely.
    let failed = session.nextLucky.get(still: false)
    _ = try? await failed.answer.value
    api.on(.post, "/api/lucky", LuckyMix(tracks: found, subtitle: "Evening: warm"))
    await model.press(session, still: false)
    #expect(asked(api) == 2)
    #expect(session.player.queue.queue.map(\.id) == foundIds)
  }

  @Test func whileTheSongsTakeAWhileDealsTheCoversAtHandAfter300msThenTheFirstSongs() async {
    let api = FakeAPI.demoLibrary()
    let session = session(api)
    let answer = Gate()
    api.hold(.post, "/api/lucky", until: answer)
    let clock = TestClock()
    let model = FeelingLuckyModel(clock: clock)
    let pressing = Task { await model.press(session, still: false) }
    #expect(await clock.nextSleep() == .milliseconds(300))
    #expect(model.deal == nil)
    #expect(model.picking)
    await shelfLoaded(session)
    clock.advance(by: .milliseconds(300))
    while model.deal == nil { await Task.yield() }
    #expect(Set(model.deal?.cards.map(\.key) ?? []) == shelfKeys)
    #expect(model.deal?.landing == nil)
    await answer.open()
    await pressing.value
    #expect(session.player.queue.queue.map(\.id) == foundIds)
    #expect(model.deal?.all.count == 5)
    #expect(model.deal?.landing?.key == cover(1))
    #expect(!model.picking)
  }

  @Test func dealsOnlyCoversWhosePicturesAreIn() async {
    let session = session()
    session.nextLucky.picture = { cover in cover.key != "/art/album/22/cover" }
    let model = FeelingLuckyModel(clock: TestClock())
    model.prepare(session, still: false)
    while !shelf.filter({ $0.id != 22 }).allSatisfy({ session.nextLucky.isLoaded(FanCover(album: $0)) }) { await Task.yield() }
    await model.press(session, still: false)
    #expect(Set(model.deal?.cards.map(\.key) ?? []) == shelfKeys.subtracting([cover(22)]))
    #expect(model.deal?.slots == 4)
    #expect(model.deal?.landing?.key == cover(1))
  }

  @Test func aCardShowingTheFirstSongsAlbumGivesWayToASpareSoNoAlbumIsDealtTwice() {
    let deal = FanDeal(cards: [1, 21, 22, 23].map { FanCover(album: album($0)) }, spares: [FanCover(album: album(20))], slots: 5)
    let landed = deal.with(landing: FanCover(album: album(1)))
    #expect(landed.all.map(\.key) == [20, 21, 22, 23, 1].map(cover))
    #expect(landed.spares.isEmpty)
    // Without a spare it stays.
    let twice = FanDeal(cards: [FanCover(album: album(1))], slots: 2).with(landing: FanCover(album: album(1)))
    #expect(twice.all.map(\.key) == [cover(1), cover(1)])
  }

  @Test func withNothingLoadedToDealWhileItPicksDealsSongsItFound() async {
    let api = FakeAPI.demoLibrary()
    let session = session(api, shelved: false)
    let answer = Gate()
    api.hold(.post, "/api/lucky", until: answer)
    let clock = TestClock()
    let model = FeelingLuckyModel(clock: clock)
    let pressing = Task { await model.press(session, still: false) }
    while !model.picking { await Task.yield() }
    // Nothing to deal while it picks: nothing waits to.
    #expect(clock.sleeping == 0)
    await answer.open()
    await pressing.value
    #expect(model.deal?.all.map(\.key) == [cover(2), cover(3), cover(4), cover(1)])
  }

  @Test func theMusicNeverWaitsAndTheFirstSongsPictureIsWaitedFor300msAtMost() async {
    let session = session(shelved: false)
    let picture = Gate()
    session.nextLucky.picture = { cover in
      if cover.key == "/art/album/1/cover" { await picture.wait() }
      return true
    }
    let clock = TestClock()
    let model = FeelingLuckyModel(clock: clock)
    let pressing = Task { await model.press(session, still: false) }
    #expect(await clock.nextSleep() == .milliseconds(300))
    #expect(session.player.queue.queue.map(\.id) == foundIds)
    #expect(model.deal == nil)
    clock.advance(by: .milliseconds(300))
    await pressing.value
    // Dealt in its own color: its picture follows when it comes.
    #expect(model.deal?.landing?.key == cover(1))
    #expect(model.deal?.cards.map(\.key) == [cover(2), cover(3), cover(4)])
    await picture.open()
  }

  @Test func putsTheCardsOutBackWhenItFindsNothingAndDealsNoneWhenItSaysSoAtOnce() async {
    let api = FakeAPI.demoLibrary()
    let session = session(api, mix: LuckyMix(tracks: [], subtitle: ""))
    let answer = Gate()
    api.hold(.post, "/api/lucky", until: answer)
    let clock = TestClock()
    let model = FeelingLuckyModel(clock: clock)
    let pressing = Task { await model.press(session, still: false) }
    #expect(await clock.nextSleep() == .milliseconds(300))
    await shelfLoaded(session)
    clock.advance(by: .milliseconds(300))
    while model.deal == nil { await Task.yield() }
    #expect(model.deal?.cards.count == 4)
    await answer.open()
    await pressing.value
    #expect(model.deal?.done == true)
    #expect(model.deal?.landing == nil)
    #expect(session.toasts.toasts.map(\.message) == ["Nothing to play yet: add some music to the library first."])
    model.dealt(press: model.presses)

    await answer.open()
    await model.press(session, still: false)
    #expect(model.deal == nil)
  }

  @Test func keepsStillUnderReduceMotion() async {
    let api = FakeAPI.demoLibrary()
    let session = session(api)
    let answer = Gate()
    api.hold(.post, "/api/lucky", until: answer)
    let clock = TestClock()
    let model = FeelingLuckyModel(clock: clock)
    let pressing = Task { await model.press(session, still: true) }
    while !model.picking { await Task.yield() }
    #expect(clock.sleeping == 0)
    await answer.open()
    await pressing.value
    #expect(session.player.queue.queue.map(\.id) == foundIds)
    #expect(model.deal == nil)
    // Nothing at hand is gathered either.
    #expect(session.nextLucky.take(still: true).hand.isEmpty)
  }

  @Test func aPressWhileItPicksDoesNothing() async {
    let api = FakeAPI.demoLibrary()
    let session = session(api)
    let answer = Gate()
    api.hold(.post, "/api/lucky", until: answer)
    let model = FeelingLuckyModel(clock: TestClock())
    let pressing = Task { await model.press(session, still: false) }
    while !model.picking { await Task.yield() }
    await model.press(session, still: false)
    #expect(model.presses == 1)
    await answer.open()
    await pressing.value
    #expect(asked(api) == 1)
  }
}

@MainActor @Suite struct CoverFanTests {
  @Test func opensClockwiseLikeAHandOfCardsTheTopOneLast() {
    let open = (0..<5).map { FanPose(card: $0, slots: 5, last: 4, out: true, phase: .open, side: 60) }
    #expect(open.map(\.angle) == [-32, -16, 0, 16, 32])
    #expect(open.allSatisfy { $0.y == -57 && $0.scale == 1 })
    // Before its turn, behind the button, turned as the first.
    #expect(FanPose(card: 3, slots: 5, last: 4, out: false, phase: .open, side: 60) == FanPose(angle: -32, y: 15))
    // Going back: the others turn in under the top one, which grows a little; then all slip down behind the button.
    #expect(FanPose(card: 1, slots: 5, last: 4, out: true, phase: .gathering, side: 44) == FanPose(angle: 32, y: -41.8))
    #expect(FanPose(card: 4, slots: 5, last: 4, out: true, phase: .gathering, side: 44).scale == 1.05)
    #expect(FanPose(card: 4, slots: 5, last: 4, out: true, phase: .gone, side: 44) == FanPose(angle: 32, y: 11))
  }

  @Test func takesAboutASecondAndAHalf() {
    let near = { (a: Duration, b: Duration) in (a > b ? a - b : b - a) < .microseconds(1) }
    // Five cards 70 ms apart, the last open 450 ms later and held 300 ms, then 460 ms going back.
    #expect(near(FanTiming.backAt(last: 4, joined: .zero, pace: 1), .milliseconds(1030)))
    #expect(near(FanTiming.backAt(last: 4, joined: .zero, pace: 1) + .seconds(FanTiming.back), .milliseconds(1490)))
    // The first song's card joining after its turn: from then.
    #expect(near(FanTiming.backAt(last: 4, joined: .milliseconds(600), pace: 1), .milliseconds(1350)))
    // Slowed down for the screen tour, all of it.
    #expect(near(FanTiming.backAt(last: 4, joined: .zero, pace: 10), .milliseconds(10_300)))
  }

  @Test func showsNothingBelowThePillsTopEdge() {
    // A regular pill is 40 in its 44 points of taps; a large one fills its 48; grown with the text, its frame.
    #expect(AbovePill(height: 40).path(in: CGRect(x: 0, y: 0, width: 160, height: 44)).boundingRect.maxY == 2)
    #expect(AbovePill(height: 48).path(in: CGRect(x: 0, y: 0, width: 160, height: 48)).boundingRect.maxY == 0)
    #expect(AbovePill(height: 40).path(in: CGRect(x: 0, y: 0, width: 160, height: 60)).boundingRect.maxY == 0)
    #expect(AbovePill(height: 48).path(in: CGRect(x: 0, y: 0, width: 160, height: 48)).boundingRect.minY < -500)
  }

  @Test func keepsTheWebsTimeOutsideTheScreenTour() {
    #expect(CoverFan.pace == 1)
    #expect(CoverFan.slowing([]) == 1)
    #expect(CoverFan.slowing(["-UITestsSlowFan"]) == 1)
    #expect(CoverFan.slowing(["-UITestsSlowFan", "0.5"]) == 1)
    #if DEBUG
      #expect(CoverFan.slowing(["-UITests", "-UITestsSlowFan", "10"]) == 10)
    #else
      #expect(CoverFan.slowing(["-UITests", "-UITestsSlowFan", "10"]) == 1)
    #endif
  }
}
