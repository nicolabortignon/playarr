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

  /// The bundled fonts don't follow Bold Text by themselves (the system's do): `followsBoldText` sets them semibold,
  /// which draws the same words wider, and leaves them be without it.
  @MainActor @Test func setsTheBundledFontsBolderWithBoldText() {
    Typography.register()
    func width(_ legibility: LegibilityWeight) -> Int {
      let text = Text("Hello wonderful world of music").font(.sans(.body)).followsBoldText().environment(\.legibilityWeight, legibility)
      return ImageRenderer(content: text.fixedSize()).cgImage?.width ?? 0
    }
    let regular = width(.regular)
    #expect(regular > 0)
    #expect(width(.bold) > regular)
    let unfollowed = ImageRenderer(content: Text("Hello wonderful world of music").font(.sans(.body)).fixedSize()).cgImage?.width
    #expect(unfollowed == regular)
  }

  @Test func tapsTheSameForTheSameKindOfThing() {
    #expect(Haptic.toast(isError: true) == .error)
    #expect(Haptic.toast(isError: false) == .success)
    // Plan 7 §7's four kinds: a toggle, a success, a selection tick, a warning.
    #expect(Haptic.toggle == .selection)
    #expect(Haptic.success == .success)
    #expect(Haptic.selection == .selection)
    #expect(Haptic.warning == .warning)
    #expect(Haptic.reorder == Haptic.selection)
    #expect(Haptic.dropped == Haptic.success)
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
