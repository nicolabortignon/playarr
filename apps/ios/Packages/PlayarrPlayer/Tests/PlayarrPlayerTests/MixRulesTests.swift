import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// The Swift ports against their TypeScript originals' answers (MixFixtures.generated.swift).
struct MixRulesTests {
  let fixtures = MixFixtures.all

  @Test func curvesReadAsTheTypeScriptReadsThem() {
    for curve in fixtures.curves {
      for v in curve.values { #expect(abs(curve.automation.value(at: v.t) - v.value) < 1e-12, "\(curve.automation) at \(v.t)") }
      for i in curve.integrals { #expect(abs(curve.automation.integral(from: i.from, to: i.to) - i.area) < 1e-12) }
    }
    #expect(Automation().value(at: 3) == 0)
  }

  @Test func aSongIsSilentFromItsGainsLastStepDown() {
    let fade: Automation = [AutomationItem(at: 0, value: 1), AutomationItem(at: 4, value: 1), AutomationItem(at: 6, value: 0)]
    #expect(fade.silentFrom(limit: 8) == 6)
    #expect(fade.silentFrom(limit: 5) == 5)
    #expect([AutomationItem(at: 0, value: 1)].silentFrom(limit: 8) == 8)
  }

  @Test func cutsAreTheWebsCuts() {
    #expect(fixtures.cuts.count > 150)
    for c in fixtures.cuts {
      let (a, b) = (fixtures.song(c.a), fixtures.song(c.b))
      let beat = MixSequence.beatCut(a, b, aDuration: c.aDuration, mode: c.mode, sameAlbumInOrder: c.sameAlbumInOrder)
      let silence = MixSequence.silenceCut(a, b, aDuration: c.aDuration, mode: c.mode, sameAlbumInOrder: c.sameAlbumInOrder)
      #expect(same(beat, c.beat), "beat cut \(c.a) → \(c.b) \(c.mode)")
      #expect(same(silence, c.silence), "silence cut \(c.a) → \(c.b) \(c.mode)")
    }
  }

  @Test func theTransitionsClockGainsAndStraightCutsAreTheWebs() {
    for p in fixtures.plans {
      #expect(same(MixSequence.straightCut(p.plan, aDuration: p.aDuration), p.straight), "straight \(p.a) → \(p.b)")
      for m in p.times {
        let shown = MixSequence.songTimeDuring(p.plan, m.t)
        #expect(shown.song == m.songTime.song && abs(shown.time - m.songTime.time) < 1e-9)
        #expect(abs(MixSequence.bTimeAt(p.plan, m.t) - m.bTime) < 1e-9)
        #expect(abs(MixSequence.bridgeGain(p.plan, m.t, gainA: 0.5, gainB: 2) - m.gain) < 1e-9)
      }
      for m in p.bTimes {
        let t = MixSequence.transitionTimeFor(p.plan, m.bTime)
        #expect((t == nil) == (m.t == nil))
        if let t, let expected = m.t { #expect(abs(t - expected) < 1e-9) }
      }
    }
  }

  @Test func skipsArePlannedAsTheTypeScriptPlansThem() {
    #expect(fixtures.skips.contains { $0.plan.style == .quick } && fixtures.skips.contains { $0.plan.style == .fade })
    for s in fixtures.skips {
      let plan = SkipPlanner.plan(a: fixtures.song(s.a), b: fixtures.song(s.b), mode: s.mode, sameAlbumInOrder: s.sameAlbumInOrder, at: s.at)
      #expect(close(plan, s.plan), "\(s.a) → \(s.b) at \(s.at): \(plan.reason) vs \(s.plan.reason)")
    }
  }

  private func same(_ x: BeatCut?, _ y: BeatCut?) -> Bool {
    switch (x, y) {
    case (nil, nil): true
    case let (x?, y?): abs(x.aEnd - y.aEnd) < 1e-9 && abs(x.bStart - y.bStart) < 1e-9
    default: false
    }
  }
}
