import SwiftUI
import Testing
@testable import PlayarrUI

/// What SwiftUI keeps and calls later, maybe while it draws an animation off the main thread (iOS 26: build 684 crashed
/// on a closure made in `body`, which is the main actor's): made by functions outside the main actor, so it can be
/// made, and run, on any thread. Covers grow into Now Playing and into their album's page; Now Playing's backdrop
/// drifts all the while.
struct DrawnOffTheMainThreadTests {
  @Test func aCoversStandInAndArtworkWordsAreDrawnOutsideTheMainActor() async {
    let made = await Task.detached {
      let label = CoverPlaceholder.drawing(initials: "MA", accent: .orange)
      let words = ArtworkText.drawing([Text("Your vibes")], spacing: 2, centred: false)
      return [type(of: label), type(of: words)].map { String(describing: $0) }
    }.value
    #expect(made.allSatisfy { $0.contains("GraphicsContext") })
  }

  @Test func theBackdropsDriftIsPosedOutsideTheMainActor() async {
    let posed = await Task.detached {
      String(describing: type(of: NowPlayingBackdrop.posed(Color.black, DriftPose.at(12))))
    }.value
    #expect(posed.contains("Color"))
  }
}
