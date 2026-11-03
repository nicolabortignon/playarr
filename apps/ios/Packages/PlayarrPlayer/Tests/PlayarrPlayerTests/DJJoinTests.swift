import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// Which join DJ mix picks from what's known, as the web's prepareBridge and joinInto do (plus what plays live here).
struct DJJoinTests {
  let fixtures = MixFixtures.all
  let file = URL(filePath: "/tmp/transition-abc.flac")

  func context(_ result: TransitionPlanner.Result?, file: URL? = nil, maps: Bool = true, position: Double = 100, mode: MixMode = .auto) -> DJJoin.Context {
    DJJoin.Context(
      result: result, file: file, a: maps ? fixtures.song("steady") : nil, b: maps ? fixtures.song("close") : nil, mode: mode,
      sameAlbumInOrder: false, aDuration: 240, position: position, gainA: -3, gainB: 2)
  }

  func plan(_ style: TransitionStyle, aStart: Double = 200, rate: Double = 1) -> TransitionPlan {
    TransitionFiles.plan(style: style, aStart: aStart, length: 8, bResume: 16, switchAt: 4, bRate: [.init(at: 0, value: rate)])
  }

  @Test func aDownloadedTransitionPlaysWithTheRestOfAnMP3AtItsLevel() {
    let ready = TransitionAnswer.Ready(
      plan: plan(.long), url: "/transitions/abc.flac", continuationUrl: "/transitions/abc.rest.flac", tail: 3, lead: 3, levels: .init(a: -3, b: 0.5))
    let (join, rest) = DJJoin.decide(context(.answer(.ready(ready)), file: file))
    #expect(join == .transition(TransitionJoin(plan: ready.plan, file: file, leadFrames: 132_300, tailFrames: 132_300, correctionA: 0, correctionB: 1.5)))
    #expect(rest == EngineItem.Continuation(url: "/transitions/abc.rest.flac", from: 16, gainDb: 1.5))
  }

  @Test func notDownloadedYetOrTooLateItCutsOnTheBeat() {
    let ready = TransitionAnswer.ready(.init(plan: plan(.long), url: "/transitions/abc.flac", lead: 3))
    let beat = MixSequence.beatCut(fixtures.song("steady"), fixtures.song("close"), aDuration: 240, mode: .auto, sameAlbumInOrder: false)
    #expect(beat != nil)
    #expect(DJJoin.decide(context(.answer(ready))).join == .cut(beat!))
    #expect(DJJoin.decide(context(.answer(ready), file: file, position: 199.5)).join == .cut(beat!))
    #expect(DJJoin.decide(context(.gaveUp)).join == .cut(beat!))
  }

  @Test func aFadeOrAQuickMixNotMadeInTimeIsPlayedLive() {
    let fade = plan(.fade)
    #expect(DJJoin.decide(context(.answer(.pending(.init(plan: fade))))).join == .mix(fade))
    let quick = plan(.quick, rate: 0.985)
    #expect(DJJoin.decide(context(.answer(.pending(.init(plan: quick))))).join == .mix(quick))
    // A long blend's stretch needs the server's file.
    #expect(DJJoin.decide(context(.answer(.pending(.init(plan: plan(.long, rate: 0.95)))))).join != .mix(plan(.long, rate: 0.95)))
  }

  @Test func straightOnCutsWhereTheServerSaysOrGoesGapless() {
    var straight = plan(.straight, aStart: 238.7)
    straight.bStart = 0.2
    #expect(DJJoin.decide(context(.answer(.straight(.init(plan: straight))))).join == .cut(BeatCut(aEnd: 238.7, bStart: 0.2)))
    straight.aStart = 240
    straight.bStart = 0
    #expect(DJJoin.decide(context(.answer(.straight(.init(plan: straight))))).join == .crossfade(seconds: 0))
  }

  @Test func withoutAnswerOrMapsTheSongsFollowGaplessAndNoMixingNeverCuts() {
    #expect(DJJoin.decide(context(nil, maps: false)).join == .crossfade(seconds: 0))
    #expect(DJJoin.decide(context(.answer(.unavailable(.init(reason: "No mix map yet"))), maps: false)).join == .crossfade(seconds: 0))
    #expect(DJJoin.decide(context(nil, mode: .off)).join == .crossfade(seconds: 0))
  }
}
