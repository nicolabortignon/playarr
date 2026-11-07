import SwiftUI
import Testing
@testable import PlayarrUI

@Suite struct AccessibilityStyleTests {
  @Test func stacksRowsAtTheAccessibilitySizes() {
    #expect(!AdaptiveStack<EmptyView>.stacks(at: .xxxLarge))
    #expect(AdaptiveStack<EmptyView>.stacks(at: .accessibility1))
    #expect(AdaptiveStack<EmptyView>.stacks(at: .accessibility5))
  }

  @Test func brightensSecondaryTextWithMoreContrast() {
    #expect(PaperDim.opacity(.standard) == 0.7)
    #expect(PaperDim.opacity(.increased) == 0.85)
    #expect(Muted.opacity(.standard) == 0.5)
    #expect(Muted.opacity(.increased) == 0.65)
  }

  @Test func tapsTheSameForTheSameKindOfThing() {
    #expect(Haptic.toast(isError: true) == .error)
    #expect(Haptic.toast(isError: false) == .success)
    #expect(Haptic.toggle == .selection)
  }
}

@Suite struct TwinkleTests {
  @Test func eachStarSwellsShrinksAndComesBack() {
    let start = Twinkle.pose(0, at: 0)
    #expect(start.0 == 1 && start.1 == 0 && start.2 == 1)
    #expect(Twinkle.pose(0, at: 0.24).0 == 1.2)  // swollen
    let gone = Twinkle.pose(0, at: 0.72)
    #expect(gone.0 == 0 && gone.1 == 45 && gone.2 == 0)  // shrunk away, turned
    #expect(Twinkle.pose(0.45, at: 0.72).2 == 0.7)  // the big one only dims
    let back = Twinkle.pose(0, at: 1.2)
    #expect(back.0 == 1 && back.2 == 1)
  }

  /// SwiftUI can draw an animation's frames off the main thread (iOS 26), where a closure of `body` traps (build 684):
  /// the stars are drawn by functions outside the main actor, which run on any thread.
  @Test func drawsTheStarsOffTheMainThread() async {
    let stars = await Task.detached { String(describing: type(of: Twinkle.stars(at: 0.3))) }.value
    #expect(stars.contains("Canvas"))
  }
}
