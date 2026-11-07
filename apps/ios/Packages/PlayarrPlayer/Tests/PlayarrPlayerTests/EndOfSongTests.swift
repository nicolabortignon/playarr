import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// Ported from apps/web/src/player/endOfSong.test.ts, then the joins only the phone knows.
@MainActor
struct EndOfSongTests {
  let next = song(2, albumId: 2)

  func handoff(_ join: Join, mix: TransitionPlan? = nil, duration: Double = 200, bpm: Double? = nil) -> EndOfSong.Handoff {
    EndOfSong.handoff(next: Track(title: "Teardrop", from: next), join: join, mix: mix, duration: duration, bpm: bpm)
  }

  @Test func saysWhatComesNextFromTenSecondsBeforeTheSongEnds() {
    #expect(EndOfSong.lead == 10)
    let gapless = handoff(.crossfade(seconds: 0))
    #expect(EndOfSong.line(gapless, time: 189.9) == nil)
    #expect(EndOfSong.line(gapless, time: 190) == "Next: Teardrop")
    #expect(EndOfSong.line(gapless, time: 199.5) == "Next: Teardrop")
  }

  @Test func saysNothingWhenNothingFollows() {
    #expect(EndOfSong.line(nil, time: 195) == nil)
  }

  @Test func countsTheTenSecondsToWhereACrossfadeStarts() {
    let fade = handoff(.crossfade(seconds: 6))
    #expect(EndOfSong.line(fade, time: 183) == nil)
    #expect(EndOfSong.line(fade, time: 184) == "Next: Teardrop")
  }

  @Test func withABlendSaysTheMixComesOnTheNextBarThroughTheLastBarThenThatItsMixing() {
    // The blend starts at 3:00 of a 3:20 song; a bar at 124 BPM lasts about 1.9 s.
    let blend = handoff(.mix(TransitionFiles.plan(style: .long, aStart: 180, length: 16, bResume: 24, switchAt: 8)), bpm: 124)
    #expect(EndOfSong.line(blend, time: 169) == nil)
    #expect(EndOfSong.line(blend, time: 170) == "Next: Teardrop")
    #expect(EndOfSong.line(blend, time: 178) == "Next: Teardrop")
    #expect(EndOfSong.line(blend, time: 178.2) == "Mixing into Teardrop on the next bar")
    #expect(EndOfSong.line(blend, time: 180) == "Mixing into Teardrop")
    #expect(EndOfSong.line(blend, time: 186) == "Mixing into Teardrop")
  }

  @Test func shortOfRoomTheLastBarSaysOnlyThatTheMixComesOnTheNextBar() {
    // The title was said a moment before ("Next: Teardrop"); the other lines are cut short at their end.
    let blend = handoff(.mix(TransitionFiles.plan(style: .long, aStart: 180, length: 16, bResume: 24, switchAt: 8)), bpm: 124)
    #expect(EndOfSong.words(blend, time: 170)?.short == nil)
    #expect(EndOfSong.words(blend, time: 178.2)?.short == "Mixing on the next bar")
    #expect(EndOfSong.words(blend, time: 181)?.short == nil)
  }

  @Test func saysAQuickMixTheSameWayWithABarOfTwoSecondsWithoutATempo() {
    let quick = handoff(.mix(TransitionFiles.plan(style: .quick, aStart: 190, length: 4, bResume: 12, switchAt: 2)))
    #expect(EndOfSong.line(quick, time: 187.9) == "Next: Teardrop")
    #expect(EndOfSong.line(quick, time: 188) == "Mixing into Teardrop on the next bar")
  }

  @Test func saysOnlyWhatComesNextForAJoinThatDoesntBlend() {
    // A fade played live, a cut on the beat: the ten seconds count to where the song gives way.
    let fade = handoff(.mix(TransitionFiles.plan(style: .fade, aStart: 180, length: 6, bResume: 6, switchAt: 3)))
    #expect(EndOfSong.line(fade, time: 169) == nil)
    #expect(EndOfSong.line(fade, time: 179.5) == "Next: Teardrop")
    #expect(EndOfSong.line(fade, time: 185) == "Next: Teardrop")
    let cut = handoff(.cut(BeatCut(aEnd: 192, bStart: 4)))
    #expect(EndOfSong.line(cut, time: 181.9) == nil)
    #expect(EndOfSong.line(cut, time: 182) == "Next: Teardrop")
  }

  @Test func goesByTheMixTheEnginePlacedWhateverTheJoinHasBecome() {
    // The answer let go at the mix point: the join is a plain end now, but the blend placed plays on.
    let placed = TransitionFiles.plan(style: .long, aStart: 180, length: 16, bResume: 24, switchAt: 8)
    #expect(EndOfSong.line(handoff(.crossfade(seconds: 0), mix: placed), time: 181) == "Mixing into Teardrop")
  }

  @Test func thePlayerSaysWhatComesNextUnlessNothingFollowsThisSong() async throws {
    let player = try Player.testing()
    player.play([song(1, duration: 12), song(2, albumId: 2)])
    #expect(player.endOfSongLine == nil)
    try await player.play(for: 2.1)
    #expect(player.endOfSongLine == "Next: Song 2")
    player.sleepAtEndOfSong()
    #expect(player.endOfSongLine == nil)
    player.cancelSleep()
    #expect(player.endOfSongLine == "Next: Song 2")
    player.cycleRepeat()
    player.cycleRepeat()  // repeat one: the song starts again, nothing follows it
    #expect(player.endOfSongLine == nil)
  }

  @Test func thePlayerSaysAPressOfNextIsMixedOnTheNextBar() async throws {
    let fixtures = MixFixtures.all
    let backend = FakeBackend()
    backend.mixMapTable.withLock { $0 = ["rec-1": fixtures.song("steady"), "rec-2": fixtures.song("close")] }
    let settings = PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!)
    settings.transitions = .dj
    let player = try Player.testing(backend, settings: settings)
    player.play([song(1, duration: 30), song(2, albumId: 2, duration: 60)])
    await eventually { player.transitions.mixMaps.map("rec-2") != nil }
    try await player.play(for: 3)
    player.next()
    guard case .mix(let plan)? = player.upcoming?.join else {
      Issue.record("no mix: \(String(describing: player.upcoming?.join))")
      return
    }
    // Planned a few seconds ahead, on a bar line: what comes next, then the bar before the mix, then the mix.
    let bar = 4 * 60 / fixtures.song("steady").bpm
    #expect(plan.aStart - player.time > bar)
    #expect(player.endOfSongLine == "Next: Song 2")
    try await player.play(for: plan.aStart - bar - player.time + 0.2)
    #expect(player.endOfSongLine == "Mixing into Song 2 on the next bar")
    try await player.play(for: plan.aStart - player.time + 0.2)
    #expect(player.queue.pos == 0)
    #expect(player.endOfSongLine == "Mixing into Song 2")
  }
}

extension Track {
  /// `track` under another title.
  init(title: String, from track: Track) {
    self = track
    self.title = title
  }
}
