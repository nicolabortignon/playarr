import PlayarrPlayer
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

  @Test func whatKeepsTimeWithTheMusicIsDrawnOutsideTheMainActor() async {
    // The bars' frames, the glow's, a blend's covers and the energy strip, all made and drawn on another thread.
    let made = await Task.detached {
      let beat = SongBeat(beat: 0.5, firstBar: 1)
      let box = CGRect(x: 0, y: 0, width: 13, height: 14)
      let phrase = EnergyPicture.Phrase(at: 0, energy: 1, start: 0, end: 8, left: 0, width: 1)
      _ = Equalizer.following(Pulse(), beat: beat, playing: true)
      _ = Equalizer.looping(since: Date())
      _ = BeatGlow.breathing(Color.orange, pulse: Pulse(), beat: beat, playing: true, opened: 0)
      _ = PlayerCover.mixing(Color.red, coming: Color.blue, blend: nil, pulse: Pulse(), still: false)
      let paths = [
        EqualizerBars(heights: Equalizer.loop(at: 1)).path(in: box), EnergyColumns(phrases: [phrase]).path(in: box),
        LitPart(fraction: 0.5).path(in: box),
      ]
      return paths.map(\.isEmpty)
    }.value
    #expect(made == [false, false, false])
  }

  @Test func theBackdropsDriftIsPosedOutsideTheMainActor() async {
    let posed = await Task.detached {
      String(describing: type(of: NowPlayingBackdrop.posed(Color.black, DriftPose.at(12))))
    }.value
    #expect(posed.contains("Color"))
  }
}
