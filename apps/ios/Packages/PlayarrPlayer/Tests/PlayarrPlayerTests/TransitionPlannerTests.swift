import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrPlayer

/// The asking and polling rules of apps/web/src/player/transitions.ts, on a clock moved by hand.
@MainActor
struct TransitionPlannerTests {
  /// The server: answers in turn (the last one repeats), every request kept.
  final class Server: Sendable {
    let requests = Mutex<[TransitionRequest]>([])
    let answers = Mutex<[Swift.Result<TransitionAnswer, APIError>]>([])
    func answer(_ request: TransitionRequest) throws -> TransitionAnswer {
      requests.withLock { $0.append(request) }
      let next = answers.withLock { a in a.count > 1 ? a.removeFirst() : a.first }
      return try (next ?? .success(.unavailable(.init(reason: "No mix map yet")))).get()
    }
    var asked: Int { requests.withLock { $0.count } }
  }

  static func plan(aStart: Double) -> TransitionPlan {
    TransitionPlan(
      style: .long, aStart: aStart, bStart: 16, length: 30, bResume: 46, switchAt: 16, bRate: [.init(at: 0, value: 1)],
      aGain: [.init(at: 0, value: 1)], bGain: [.init(at: 0, value: 0)], aLowDb: [.init(at: 0, value: 0)], bLowDb: [.init(at: 0, value: 0)],
      aHighPassHz: [.init(at: 0, value: 20)], reason: "Same tempo, keys compatible: 64-beat blend", beats: 64)
  }
  static let pending = TransitionAnswer.pending(.init(plan: plan(aStart: 180), render: RenderProgress(step: .mixing, done: 0.43)))
  static let ready = TransitionAnswer.ready(.init(plan: plan(aStart: 180), url: "/transitions/abc.flac", lead: 3, levels: .init(a: -3, b: 1.5)))

  let clock = ManualScheduling()
  let server = Server()
  let pair = TransitionPlanner.Pair(from: song(1, duration: 240), to: song(2, albumId: 2), mode: .auto, fade: 6, albumQueue: false, levels: nil)

  func planner(playing: @escaping @MainActor () -> Bool = { true }, online: @escaping @MainActor () -> Bool = { true }) -> TransitionPlanner {
    let server = self.server
    let planner = TransitionPlanner(scheduler: clock) { try server.answer($0) }
    planner.isPlaying = playing
    planner.isOnline = online
    return planner
  }

  /// Plays `seconds` from `from`, ticking every quarter second (a whole number of binary fractions, so the times
  /// add up exactly), letting each ask finish.
  func play(_ planner: TransitionPlanner, from: Double, for seconds: Double) async {
    var t = from
    for _ in 0..<Int((seconds * 4).rounded()) {
      clock.advance(by: 0.25)
      t += 0.25
      planner.clock(t, seeked: false)
      await planner.inFlight?.value
    }
  }

  /// The pair wanted from the song's start, its clock at 0 (the Player's tick right after a load).
  func begin(_ planner: TransitionPlanner, _ pair: TransitionPlanner.Pair? = nil, restart: Int = 0) {
    planner.update(wanted: pair ?? self.pair, playing: (1, restart))
    planner.clock(0, seeked: false)
  }

  func jump(_ planner: TransitionPlanner, to time: Double) async {
    clock.advance(by: 0.25)
    planner.clock(time, seeked: true)
    await planner.inFlight?.value
  }

  @Test func asksOnceTheSongHasPlayedFiveSecondsAndTwoAfterThePairSettles() async {
    let planner = planner()
    begin(planner)
    #expect(planner.upcoming == .init(fromFileId: 1, toFileId: 2, result: nil))
    await play(planner, from: 0, for: 4.75)
    #expect(server.asked == 0)
    await play(planner, from: 4.75, for: 0.25)
    #expect(server.asked == 1)
    let sent = server.requests.withLock { $0[0] }
    #expect(sent == TransitionRequest(from: 1, to: 2, mode: .auto, position: 5, fromFileId: 1, toFileId: 2, fade: 6, albumQueue: false))
  }

  @Test func aSeekDoesNotCountAsListening() async {
    let planner = planner()
    begin(planner)
    await jump(planner, to: 60)
    await play(planner, from: 60, for: 3)
    #expect(server.asked == 0)
    await play(planner, from: 63, for: 2)
    #expect(server.asked == 1)
  }

  @Test func pollsEveryThreeSecondsThenEveryTenAndKeepsThePosition() async {
    server.answers.withLock { $0 = [.success(Self.pending)] }
    let planner = planner()
    begin(planner)
    await play(planner, from: 0, for: 5)
    #expect(server.asked == 1)
    #expect(planner.upcoming.result == .answer(Self.pending))
    await play(planner, from: 5, for: 12)  // at 8, 11, 14 and 17
    #expect(server.asked == 5)
    await play(planner, from: 17, for: 9.75)  // five answers "pending": every 10 s from here
    #expect(server.asked == 5)
    await play(planner, from: 26.75, for: 0.25)
    #expect(server.asked == 6)
    #expect(Set(server.requests.withLock { $0.map(\.position) }) == [5])
  }

  @Test func pollsEveryTenSecondsWhilePaused() async {
    server.answers.withLock { $0 = [.success(Self.pending)] }
    let planner = planner(playing: { false })
    begin(planner)
    await play(planner, from: 0, for: 5)
    await play(planner, from: 5, for: 9.75)
    #expect(server.asked == 1)
    await play(planner, from: 14.75, for: 0.25)
    #expect(server.asked == 2)
  }

  @Test func errorsAreTriedAgainAfterThreeSecondsThenTenAndARefusalGivesUp() async {
    server.answers.withLock {
      $0 = [.failure(.server(status: 503, message: "busy")), .failure(.offline), .failure(.server(status: 429, message: "slow down")), .success(Self.ready)]
    }
    let planner = planner()
    begin(planner)
    await play(planner, from: 0, for: 5)
    #expect(server.asked == 1)
    await play(planner, from: 5, for: 3)
    #expect(server.asked == 2)
    await play(planner, from: 8, for: 9.75)
    #expect(server.asked == 2)
    await play(planner, from: 17.75, for: 0.25)
    #expect(server.asked == 3)
    await play(planner, from: 18, for: 10)
    #expect(server.asked == 4)
    #expect(planner.upcoming.result == .answer(Self.ready))
    await play(planner, from: 28, for: 30)
    #expect(server.asked == 4)  // answered for good

    let refusing = Server()
    refusing.answers.withLock { $0 = [.failure(.server(status: 404, message: "Unknown track"))] }
    let other = TransitionPlanner(scheduler: clock) { try refusing.answer($0) }
    other.update(wanted: pair, playing: (1, 0))
    other.clock(0, seeked: false)
    await play(other, from: 0, for: 5)
    #expect(other.upcoming.result == .gaveUp)
  }

  @Test func offlineItWaitsForTheNetwork() async {
    let network = Mutex(false)
    let planner = planner(online: { network.withLock { $0 } })
    begin(planner)
    await play(planner, from: 0, for: 8)
    #expect(server.asked == 0)
    network.withLock { $0 = true }
    planner.networkChanged()
    await planner.inFlight?.value
    #expect(server.asked == 1)
  }

  @Test func unavailableIsAskedOnceMoreAfterAMinute() async {
    let planner = planner()
    begin(planner)
    await play(planner, from: 0, for: 5)
    await play(planner, from: 5, for: 59.75)
    #expect(server.asked == 1)
    await play(planner, from: 64.75, for: 0.25)
    #expect(server.asked == 2)
    await play(planner, from: 65, for: 100)
    #expect(server.asked == 2)
  }

  @Test func givesUpTwentySecondsBeforeTheMixPointAndARestartAsksAgain() async {
    server.answers.withLock { $0 = [.success(Self.pending)] }
    let planner = planner()
    begin(planner)
    await jump(planner, to: 150)
    await play(planner, from: 150, for: 9.75)
    #expect(planner.upcoming.result == .answer(Self.pending))
    await play(planner, from: 159.75, for: 0.25)  // 160 = aStart − 20
    #expect(planner.upcoming.result == .gaveUp)
    let asked = server.asked
    await play(planner, from: 160, for: 20)
    #expect(server.asked == asked)
    // Back to the start (a restart): there's time again, so it's asked afresh, from where it is then.
    planner.update(wanted: pair, playing: (1, 1))
    await jump(planner, to: 0)
    #expect(planner.upcoming.result == nil)
    await play(planner, from: 0, for: 5)
    #expect(server.asked == asked + 1)
    #expect(server.requests.withLock { $0.last?.position } == 5)
  }

  @Test func aSeekPastAReadyMixPointAsksAfreshFromThere() async {
    server.answers.withLock { $0 = [.success(Self.ready), .success(Self.pending)] }
    let planner = planner()
    begin(planner)
    await play(planner, from: 0, for: 5)
    #expect(planner.upcoming.result == .answer(Self.ready))
    clock.advance(by: 0.25)
    planner.clock(179.5, seeked: true)
    #expect(planner.upcoming.result == nil)
    await planner.inFlight?.value
    #expect(server.requests.withLock { $0.last?.position } == 179.5)
    #expect(planner.upcoming.result == .gaveUp)  // too close to its mix point to be made in time
  }

  @Test func aLevelLearnedIsAnotherPair() async {
    server.answers.withLock { $0 = [.success(Self.ready)] }
    let planner = planner()
    begin(planner)
    await play(planner, from: 0, for: 5)
    #expect(server.asked == 1)
    var levelled = pair
    levelled.levels = .init(a: 0, b: -4.5)
    planner.update(wanted: levelled, playing: (1, 0))
    #expect(planner.upcoming.result == nil)
    await play(planner, from: 5, for: 2)
    #expect(server.asked == 2)
    #expect(server.requests.withLock { $0.last?.levels } == .init(a: 0, b: -4.5))
  }

  @Test func noPairNoAsking() async {
    let planner = planner()
    planner.update(wanted: nil, playing: (1, 0))
    planner.clock(0, seeked: false)
    await play(planner, from: 0, for: 30)
    #expect(server.asked == 0)
    #expect(planner.upcoming == .init())
  }
}
