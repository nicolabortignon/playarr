import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct MixOrbitTests {
  typealias C = MixOrbit.Circle

  // The same numbers are expected by the web's mixOrbit.test.ts: the two must draw a mix alike.
  @Test func laysAMixOutFromItsKeyAloneAsTheWebDoes() {
    #expect(MixOrbit.hash32("vibes") == 164_168_766)
    #expect(MixOrbit.hash32("genre-jazz") == 3_314_012_070)
    let next = MixOrbit.random(MixOrbit.hash32("vibes"))
    #expect(abs(next() - 0.14976447564549744) < 1e-12)
    #expect(
      MixOrbit.layout(key: "vibes", covers: 4)
        == MixOrbit.Layout(
          hero: C(x: 0.669, y: 0.3149, d: 0.62), ring: 0.43,
          satellites: [C(x: 0.2975, y: 0.0983, d: 0.19), C(x: 0.2564, y: 0.436, d: 0.15), C(x: 0.9687, y: 0.6232, d: 0.12)],
          dot: nil))
    #expect(
      MixOrbit.layout(key: "decade-1990", covers: 1)
        == MixOrbit.Layout(hero: C(x: 0.6885, y: 0.2895, d: 0.62), ring: 0.43, satellites: [], dot: C(x: 0.3562, y: 0.0165, d: 0.05)))
  }

  @Test func givesEachCoverAfterTheFirstACircleThreeAtMost() {
    #expect(MixOrbit.layout(key: "vibes", covers: 0).satellites.isEmpty)
    #expect(MixOrbit.layout(key: "vibes", covers: 2).satellites.count == 1)
    #expect(MixOrbit.layout(key: "vibes", covers: 3).satellites.count == 2)
    #expect(MixOrbit.layout(key: "vibes", covers: 9).satellites.count == 3)
  }

  @Test func keepsEveryCircleOnTheCoverClearOfTheTitleAndOfEachOther() {
    var three = 0
    for i in 0..<500 {
      let layout = MixOrbit.layout(key: "mix-\(i)", covers: 4)
      let satellites = layout.satellites
      #expect(satellites.count >= 1)
      if satellites.count == 3 { three += 1 }
      for c in [layout.hero] + satellites { #expect(MixOrbit.fits(c)) }
      for a in satellites.indices {
        for b in satellites.indices where b > a { #expect(MixOrbit.apart(satellites[a], satellites[b])) }
      }
    }
    #expect(three > 450)
    #expect(!MixOrbit.fits(C(x: 0.3, y: 0.8, d: 0.2)))
    #expect(!MixOrbit.fits(C(x: 1.08, y: 0.4, d: 0.12)))
  }

  // Also expected by the web's mixOrbit.test.ts.
  @Test func runsAWashBetweenTwoHuesTheShortWayRoundAtTheSameLightnessAsAnyOtherMix() {
    #expect(MixOrbit.wash(from: 350, to: 30).map(\.h) == [350, 359, 8, 19, 30])
    #expect(MixOrbit.wash(from: 10, to: 300).map(\.h) == [10, 354.25, 338.5, 319.25, 300])
    #expect(
      MixOrbit.wash(from: 200) == [
        .init(at: 0, l: 0.5, c: 0.15, h: 200), .init(at: 0.225, l: 0.42, c: 0.13, h: 200), .init(at: 0.45, l: 0.34, c: 0.11, h: 200),
        .init(at: 0.725, l: 0.26, c: 0.085, h: 200), .init(at: 1, l: 0.18, c: 0.06, h: 200),
      ])
    #expect(MixKind.allCases.filter(MixOrbit.toneFromCovers) == [.vibes, .discovery, .repeat])
  }

  @Test func placesColoursOnTheOKLCHWheelAsTheWebDoes() {
    #expect(abs(OKLCH.hue(of: RGB(r: 1, g: 0, b: 0)) - 29.23) < 0.01)
    #expect(abs(OKLCH.hue(of: RGB(r: 0, g: 1, b: 0)) - 142.5) < 0.1)
    #expect(abs(OKLCH.hue(of: RGB(r: 0, g: 0, b: 1)) - 264.05) < 0.01)
  }
}
