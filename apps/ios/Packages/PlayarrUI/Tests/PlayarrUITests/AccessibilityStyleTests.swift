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
    #expect(Muted.opacity(.standard) == 0.7)
    #expect(Muted.opacity(.increased) == 0.85)
  }

  @Test func tapsTheSameForTheSameKindOfThing() {
    #expect(Haptic.toast(isError: true) == .error)
    #expect(Haptic.toast(isError: false) == .success)
    #expect(Haptic.toggle == .selection)
  }
}
