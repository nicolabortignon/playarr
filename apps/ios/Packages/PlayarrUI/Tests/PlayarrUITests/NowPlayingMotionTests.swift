import Foundation
import Testing
@testable import PlayarrUI

/// Now Playing's cover and backdrop as objects (plan 7 §3): the backdrop's drift and the cover's tilt.
@MainActor @Suite struct NowPlayingMotionTests {
  func close(_ a: DriftPose, _ b: DriftPose) -> Bool {
    abs(a.x - b.x) < 1e-9 && abs(a.y - b.y) < 1e-9 && abs(a.degrees - b.degrees) < 1e-9 && abs(a.scale - b.scale) < 1e-9
  }

  @Test func theBackdropDriftsThroughTheWebsPosesFortySecondsEachWay() {
    let thirtyFive = DriftPose(x: -0.05, y: 0.04, degrees: 8, scale: 1.1)
    #expect(DriftPose.at(0) == DriftPose())
    // 35 % of the way out, and again on the way back.
    #expect(close(DriftPose.at(14), thirtyFive))
    #expect(close(DriftPose.at(66), thirtyFive))
    #expect(close(DriftPose.at(40), DriftPose(x: -0.03, y: -0.04, degrees: 12, scale: 1.14)))
    // Home again after 80 seconds, and round once more.
    #expect(DriftPose.at(80) == DriftPose())
    #expect(close(DriftPose.at(94), thirtyFive))
  }

  @Test func theDriftEasesInAndOutOfEachPoseWithoutJumping() {
    // Halfway between two poses is halfway (ease-in-out is symmetric); near a pose it barely moves.
    #expect(abs(DriftPose.at(7).degrees - 4) < 0.01)
    #expect(DriftPose.at(0.5).degrees < 0.05)
    // From one step to the next (ten a second), never more than 0.3°: 2.6° a second at its fastest.
    var biggest = 0.0
    for step in 0..<(80 * 100) {
      let t = Double(step) / 100
      biggest = max(biggest, abs(DriftPose.at(t + NowPlayingBackdrop.step).degrees - DriftPose.at(t).degrees))
    }
    #expect(biggest < 0.3)
    #expect(biggest > 0.2)
  }

  @Test func theCoverLeansAgainstThePhonesTurnUpToOneDegree() {
    let degree = Double.pi / 180
    // Upright, the phone's right edge turned 4° away (about its own top axis): the cover's right edge comes toward you,
    // half the way (an eighth of 4° is ½° of the 1°).
    let turnedAway = CoverTilt.lean(turned: (x: 0, y: 4 * degree, z: 0), orientation: .portrait)
    #expect(abs(turnedAway.h - 0.5) < 1e-9)
    #expect(turnedAway.v == 0)
    // Its top turned toward you: the cover's top goes away.
    #expect(CoverTilt.lean(turned: (x: 4 * degree, y: 0, z: 0), orientation: .portrait).v < 0)
    // Never more than 1°.
    #expect(CoverTilt.lean(turned: (x: 0, y: 30 * degree, z: 0), orientation: .portrait).h == 1)
    // Sideways, the screen's up runs along the phone's x axis: the same turn of the screen leans it the same way.
    let sideways = CoverTilt.lean(turned: (x: 4 * degree, y: 0, z: 0), orientation: .landscapeRight)
    #expect(abs(sideways.h - 0.5) < 1e-9)
    #expect(abs(CoverTilt.lean(turned: (x: -4 * degree, y: 0, z: 0), orientation: .landscapeLeft).h - 0.5) < 1e-9)
  }

  @Test func theCoverComesBackToRestFlatOnceThePhoneIsStill() {
    let tilt = CoverTilt()
    tilt.turn(by: (x: 0, y: 0, z: 0), at: 0, orientation: .portrait)
    // Turned at 40° a second for a tenth of a second: 4° away.
    tilt.turn(by: (x: 0, y: 40 * .pi / 180, z: 0), at: 0.1, orientation: .portrait)
    #expect(tilt.lean.h > 0.4)
    var time = 0.1
    for _ in 0..<90 {
      time += 0.1
      tilt.turn(by: (x: 0, y: 0, z: 0), at: time, orientation: .portrait)
    }
    #expect(tilt.lean == CoverTilt.Lean())
  }

  @Test func theTiltLastsUntilTheLastCoverThatTiltsHasGone() {
    let tilt = CoverTilt()
    // Now Playing open over an album page: two covers tilting.
    tilt.start()
    tilt.start()
    tilt.turn(by: (x: 0, y: 0, z: 0), at: 0, orientation: .portrait)
    tilt.turn(by: (x: 0, y: 40 * .pi / 180, z: 0), at: 0.1, orientation: .portrait)
    tilt.stop()
    #expect(tilt.lean.h > 0.4)
    tilt.stop()
    #expect(tilt.lean == CoverTilt.Lean())
    // A stop too many doesn't leave the next cover without the gyroscope.
    tilt.stop()
    tilt.start()
    tilt.turn(by: (x: 0, y: 0, z: 0), at: 1, orientation: .portrait)
    tilt.turn(by: (x: 0, y: 40 * .pi / 180, z: 0), at: 1.1, orientation: .portrait)
    tilt.stop()
    #expect(tilt.lean == CoverTilt.Lean())
  }

  @Test func aPhoneLyingStillLeavesTheCoverAlone() {
    let tilt = CoverTilt()
    var time = 0.0
    for k in 0..<600 {
      time += 1.0 / 60
      // The gyroscope's noise: never quite nothing, nothing to see.
      let noise = (k % 2 == 0 ? 1.0 : -1.0) * 0.002
      tilt.turn(by: (x: noise, y: -noise, z: noise), at: time, orientation: .portrait)
    }
    #expect(tilt.lean == CoverTilt.Lean())
  }

  @Test func theBackdropGoesFlatUnderIncreaseContrastOrReduceTransparency() {
    #expect(!NowPlayingBackdrop.isFlat(contrast: .standard, reducesTransparency: false))
    #expect(NowPlayingBackdrop.isFlat(contrast: .increased, reducesTransparency: false))
    #expect(NowPlayingBackdrop.isFlat(contrast: .standard, reducesTransparency: true))
  }
}
