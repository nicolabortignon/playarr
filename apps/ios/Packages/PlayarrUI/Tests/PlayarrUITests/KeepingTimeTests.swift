import Foundation
import PlayarrAPI
import PlayarrPlayer
import SwiftUI
import Testing
@testable import PlayarrUI

/// What keeps time with the music on screen (plan 7 §2, §6): the bars' loop and shape, Now Playing's glow, and the
/// energy strip under the seek bar.
struct KeepingTimeTests {
  /// 120 BPM, its first downbeat at 1 s: bars every 2 s, phrases every 8 s, the first quiet, the second loud.
  let beat = SongBeat(beat: 0.5, firstBar: 1, phraseEnergy: [0.2, 1])

  // MARK: The bars

  @Test func theLoopStartsAtTheBarsShapeAndEachBarRisesFromAQuarterOfIt() {
    #expect(Equalizer.loop(at: 0) == Equalizer.shape)
    // The bass begins at once, from a quarter of its height, and is back at full height after its 0.7 s…
    #expect(abs(Equalizer.loop(at: 0.001).bass - 0.25 * 0.9) < 0.001)
    #expect(abs(Equalizer.loop(at: 0.35).bass - 0.9 * (0.25 + 0.75 * 0.5)) < 1e-9)  // halfway: eased in and out
    #expect(abs(Equalizer.loop(at: 0.6999).bass - 0.9) < 0.001)
    // …then goes back down over the next 0.7 s (alternating), and up again.
    #expect(abs(Equalizer.loop(at: 1.3999).bass - 0.25 * 0.9) < 0.001)
    #expect(abs(Equalizer.loop(at: 2.1).bass - 0.9) < 0.001)
    // The middle starts 0.15 s later, the treble 0.3 s: until then they keep their shape.
    #expect(Equalizer.loop(at: 0.1).middle == Equalizer.shape.middle)
    #expect(Equalizer.loop(at: 0.2).treble == Equalizer.shape.treble)
    #expect(abs(Equalizer.loop(at: 0.151).middle - 0.25 * 0.5) < 0.001)
  }

  @Test func theBarsStandOnTheBottomThreePointsWideTwoApart() {
    let path = EqualizerBars(heights: BandLevels(bass: 1, middle: 0.5, treble: SongBeat.barRest)).path(in: CGRect(x: 0, y: 0, width: 13, height: 14))
    #expect(path.boundingRect == CGRect(x: 0, y: 0, width: 13, height: 14))
    // The middle bar alone: from 5 to 8 points across, half the height, standing on the bottom.
    let middle = path.intersection(Path(CGRect(x: 4, y: 0, width: 5, height: 14))).boundingRect
    #expect(abs(middle.minX - 5) < 1e-9 && abs(middle.width - 3) < 1e-9)
    #expect(abs(middle.minY - 7) < 1e-9 && abs(middle.maxY - 14) < 1e-9)
  }

  // MARK: Now Playing's glow

  @Test func theGlowIsAQuarterOfTheAccentAtMostOnTheDownbeatOfABusyPhrase() {
    // The downbeat of the bar at 9 s, in the loud phrase: 0.08 + 0.16 × (0.5 + 0.5 × 1) × 1, swollen by 4 %.
    let loud = BeatGlow.pose(beat, at: 9, shown: 5)
    #expect(abs(loud.opacity - 0.24) < 1e-9)
    #expect(abs(loud.scale - 1.04) < 1e-9)
    // In the quiet phrase: 0.08 + 0.16 × (0.5 + 0.5 × 0.2).
    #expect(abs(BeatGlow.pose(beat, at: 3, shown: 5).opacity - (0.08 + 0.16 * 0.6)) < 1e-9)
    // Late in the bar, before it breathes in for the next downbeat, it rests near its least, never gone while it plays.
    #expect(BeatGlow.pose(beat, at: 10.6, shown: 5).opacity < 0.09)
    #expect(BeatGlow.pose(beat, at: 10.6, shown: 5).opacity >= 0.08)
    var strongest = 0.0
    for t in stride(from: 0.0, to: 20, by: 1.0 / 60) { strongest = max(strongest, BeatGlow.pose(beat, at: t, shown: 5).opacity) }
    #expect(strongest <= 0.25)
  }

  @Test func theGlowComesInOverSevenTenthsOfASecond() {
    #expect(BeatGlow.pose(beat, at: 9, shown: 0).opacity == 0)
    #expect(abs(BeatGlow.pose(beat, at: 9, shown: 0.35).opacity - 0.12) < 1e-9)
    #expect(abs(BeatGlow.pose(beat, at: 9, shown: 0.7).opacity - 0.24) < 1e-9)
  }

  // MARK: The energy strip

  @Test func theStripsColumnsAreAsTallAsEachPhraseSoundsAPointApart() {
    let phrases = [
      EnergyPicture.Phrase(at: 0, energy: 1, start: 0, end: 8, left: 0, width: 0.5),
      EnergyPicture.Phrase(at: 8, energy: 0, start: 8, end: 16, left: 0.5, width: 0.5),
    ]
    let box = CGRect(x: 0, y: 0, width: 200, height: 20)
    let path = EnergyColumns(phrases: phrases).path(in: box)
    let loud = path.intersection(Path(CGRect(x: 0, y: 0, width: 100, height: 20))).boundingRect
    let quiet = path.intersection(Path(CGRect(x: 100, y: 0, width: 100, height: 20))).boundingRect
    #expect(abs(loud.width - 99) < 1e-9 && abs(loud.height - 20) < 1e-9)
    // Silent, still two points tall, so the phrase shows.
    #expect(abs(quiet.minX - 100) < 1e-9 && abs(quiet.height - 2) < 1e-9 && abs(quiet.maxY - 20) < 1e-9)
    // Lit up to where the song is: a third of the way.
    #expect(abs(LitPart(fraction: 1.0 / 3).path(in: box).boundingRect.width - 200.0 / 3) < 1e-9)
    #expect(LitPart(fraction: 2).path(in: box).boundingRect.width == 200)  // never past the end
  }

  @Test func theStripSeeksWhereTheSlidersThumbWouldBe() {
    // 337 points wide: the thumb's center travels 300 of them, from 18.5 in from each end.
    #expect(SeekBar.time(at: 18.5, width: 337, duration: 240) == 0)
    #expect(SeekBar.time(at: 168.5, width: 337, duration: 240) == 120)
    #expect(SeekBar.time(at: 318.5, width: 337, duration: 240) == 240)
    // Pressed past either end of the travel: the song's start or its end.
    #expect(SeekBar.time(at: 4, width: 337, duration: 240) == 0)
    #expect(SeekBar.time(at: 335, width: 337, duration: 240) == 240)
  }
}
