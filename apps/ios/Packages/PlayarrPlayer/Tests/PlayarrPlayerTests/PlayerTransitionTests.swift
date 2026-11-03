import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// DJ mix through the Player: asking, the transition file, presses of Next, the sleep timer, mixing off.
@MainActor
@Suite(.serialized)
struct PlayerTransitionTests {
  let clock = ManualScheduling()
  let backend = FakeBackend()
  let directory = temporaryDirectory()

  func player() throws -> Player {
    let settings = PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!)
    settings.transitions = .dj
    return try Player.testing(backend, directory: directory, settings: settings, scheduler: clock)
  }

  /// Plays `seconds` in steps of 0.1 s, the clock moving with the audio.
  func play(_ player: Player, for seconds: Double) async throws {
    for _ in 0..<Int((seconds * 10).rounded()) {
      _ = try await player.engine.render(seconds: 0.1)
      clock.advance(by: 0.1)
      player.tick()
      await player.transitions.planner.inFlight?.value
      await Task.yield()
    }
  }

  let a = song(1, duration: 30), b = song(2, albumId: 2, duration: 60)

  @Test func asksWithTheGainsThePhonePlaysEachSongAt() async throws {
    backend.levelTable.withLock { $0 = ["rec-1": TrackLevel(track: -5), "rec-2": TrackLevel(track: 3)] }
    let player = try player()
    player.play([a, b])
    try await play(player, for: 6)
    let asked = try #require(backend.transitionAsks.all.last)
    #expect(asked.from == 1 && asked.to == 2 && asked.mode == .auto)
    #expect(asked.levels == .init(a: 0, b: 3))  // A was loaded before its level came: it plays at 0 dB to its end
    #expect(asked.fade == 6)
  }

  @Test func aReadyTransitionIsDownloadedAndPlayedAndTheQueueMovesOnAtTheSwitch() async throws {
    // A's mix point at 30 s (asked at 5 s, more than 20 s before it); a 1 s lead, 2 s of transition, B on from 10 s.
    let plan = TransitionFiles.plan(aStart: 30, length: 2, bResume: 10, switchAt: 1)
    backend.transitionAnswers.withLock { $0["1-2"] = [.ready(.init(plan: plan, url: "/transitions/abc.flac", tail: 1, lead: 1))] }
    // Already in the stream cache, as if downloaded: the coordinator takes it from there.
    let file = try TransitionFiles.flac(frames: 4 * 44_100) { _, _ in 0.1 }
    try FileManager.default.createDirectory(at: directory.appending(path: "stream"), withIntermediateDirectories: true)
    try FileManager.default.copyItem(at: file, to: directory.appending(path: "stream/transition-abc.flac"))
    let player = try player()
    player.play([song(1, duration: 60), b])
    try await play(player, for: 6)
    guard case .transition(let join)? = player.upcoming?.join else {
      Issue.record("no transition: \(String(describing: player.upcoming?.join))")
      return
    }
    #expect(join.leadFrames == 44_100)
    player.seek(to: 27)  // a ready transition survives a seek that lands before its mix point
    try await play(player, for: 3.5)  // 30.5 s: in the transition, before the switch
    #expect(player.queue.pos == 0)
    #expect(player.engine.mix?.way == .server)
    try await play(player, for: 1)  // past the switch at 31 s
    #expect(player.queue.pos == 1)
    #expect(abs(player.time - 9.5) < 0.2)  // B's time: in from 8 s, on from 10 s at the transition's end
    #expect(player.engine.mixReports[.mixIn]?.sample == player.engine.mixReports[.mixOut].map { $0.sample - 2 * 44_100 - 44_100 / 2 })
  }

  @Test func aPressOfNextMixesOnTheNextBar() async throws {
    let fixtures = MixFixtures.all
    backend.mixMapTable.withLock { $0 = ["rec-1": fixtures.song("steady"), "rec-2": fixtures.song("close")] }
    let player = try player()
    player.play([a, b])
    try await play(player, for: 3)
    player.next()
    #expect(player.queue.pos == 0)  // A plays on until the mix
    guard case .mix(let plan)? = player.upcoming?.join else {
      Issue.record("no mix: \(String(describing: player.upcoming?.join))")
      return
    }
    #expect(plan.style == .quick)
    #expect(plan.aStart >= 3 + 2.5 + 0.5 + 0.25 - 0.11)
    #expect(plan.aStart <= 3 + 2.5 + 0.5 + 0.25 + 4 * 0.5)  // the next bar line, a 2- or 4-beat lead-in
    try await play(player, for: plan.aStart - player.time + plan.switchAt + 0.3)
    #expect(player.queue.pos == 1)
    await eventually { !backend.plays.withLock { $0.isEmpty } }
    #expect(backend.plays.withLock { $0.first?.skipped } == true)
  }

  @Test func pressedAgainWhileItWaitsTheSongChangesAtOnce() async throws {
    let fixtures = MixFixtures.all
    backend.mixMapTable.withLock { $0 = ["rec-1": fixtures.song("steady"), "rec-2": fixtures.song("close")] }
    let player = try player()
    player.play([a, b])
    try await play(player, for: 3)
    player.next()
    player.next()
    #expect(player.queue.pos == 1)
  }

  @Test func withoutMixMapsAPressOfNextIsAPlainSkip() async throws {
    let player = try player()
    player.play([a, b])
    try await play(player, for: 3)
    player.next()
    #expect(player.queue.pos == 1)
  }

  @Test func theSleepTimersEndOfSongAsksForNoTransition() async throws {
    let player = try player()
    player.play([a, b])
    player.sleepAtEndOfSong()
    try await play(player, for: 7)
    #expect(backend.transitionAsks.all.isEmpty)
    #expect(player.upcoming == nil)
  }

  @Test func noMixingAsksNothingAndPlaysTheNextSongGapless() async throws {
    let fixtures = MixFixtures.all
    backend.mixMapTable.withLock { $0 = ["rec-1": fixtures.song("steady"), "rec-2": fixtures.song("close")] }
    let player = try player()
    player.play([a, b])
    player.setMixMode(.off)
    try await play(player, for: 7)
    #expect(backend.transitionAsks.all.isEmpty)
    #expect(player.upcoming?.join == .crossfade(seconds: 0))
  }

  @Test func djMixKeepsLessScheduledAhead() throws {
    let player = try player()
    player.play([a, b])
    #expect(player.engine.tuning.scheduleAhead == 2.5)
    player.settings.transitions = .crossfade
    player.play([a, b])
    #expect(player.engine.tuning.scheduleAhead == 10)
  }

  @Test func aClosedSessionAsksForNoMoreTransitions() async throws {
    let player = try player()
    player.play([a, b])
    try await play(player, for: 1)
    player.shutDown()
    clock.advance(by: 30)
    await player.transitions.planner.inFlight?.value
    #expect(backend.transitionAsks.all.isEmpty)
    #expect(player.transitions.planner.upcoming == .init())
  }

  @Test func editedMixPointsAskAgainForTheMapAndTheTransition() async throws {
    let fixtures = MixFixtures.all
    backend.mixMapTable.withLock { $0 = ["rec-1": fixtures.song("steady"), "rec-2": fixtures.song("close")] }
    let player = try player()
    player.play([a, b])
    try await play(player, for: 8)
    let asks = backend.transitionAsks.all.count
    #expect(asks == 1)
    backend.mixMapTable.withLock { $0["rec-2"] = fixtures.song("cues") }
    player.mixPointsChanged(recordingId: "rec-2")
    try await play(player, for: 3)
    #expect(backend.transitionAsks.all.count == asks + 1)
    #expect(player.transitions.mixMaps.map("rec-2") == fixtures.song("cues"))
  }
}
