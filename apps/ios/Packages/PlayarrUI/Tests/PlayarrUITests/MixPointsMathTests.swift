import PlayarrAPI
import Testing
@testable import PlayarrUI

/// A song at 120 BPM (a bar is 2 s) whose first downbeat is 0.5 s in: bar lines at 0.5, 2.5, 4.5, …
func mixMap(bpm: Double = 120, duration: Double = 200, introEnd: Double = 16.5, outroStart: Double = 176.5, soundEnd: Double = 199, energy: [Double?] = [0.2, 1, nil, 0.5], cues: CuePoints? = nil) -> MixMapEntry {
  MixMapEntry(
    version: mixMapVersion, duration: duration, bpm: bpm, firstBeat: 0.5, downbeatOffset: 0, gridStable: true, beatConfidence: 0.9,
    introEnd: introEnd, outroStart: outroStart, coldStart: false, coldEnd: false, soundEnd: soundEnd, phraseEnergy: energy, cues: cues)
}

@Suite struct MixGridTests {
  let grid = MixGrid(map: mixMap())

  @Test func snapsToBarsFromTheFirstDownbeat() {
    #expect(grid == MixGrid(origin: 0.5, step: 2, big: 4))
    #expect(grid.snap(17.4, min: 0, max: 100) == 16.5)
    #expect(grid.snap(17.6, min: 0, max: 100) == 18.5)
    #expect(grid.snap(0.1, min: 0, max: 100) == 0.5)
    #expect(grid.snap(150, min: 0, max: 100) == 98.5)
  }

  @Test func stepsABarOrAPhraseLandingOnTheNextLineFirst() {
    #expect(grid.step(from: 16.5, by: 1, min: 0, max: 100) == 18.5)
    #expect(grid.step(from: 16.5, by: -4, min: 0, max: 100) == 8.5)
    #expect(grid.step(from: 17.3, by: 1, min: 0, max: 100) == 18.5)
    #expect(grid.step(from: 17.3, by: -1, min: 0, max: 100) == 16.5)
    #expect(grid.step(from: 2.5, by: -4, min: 0, max: 100) == 0.5)
  }

  @Test func movesByWholeSecondsWithoutABeat() {
    let seconds = MixGrid(map: mixMap(bpm: 0))
    #expect(seconds == MixGrid(origin: 0, step: 1, big: 10))
    #expect(seconds.step(from: 12.4, by: 10, min: 0, max: 100) == 22)
  }

  @Test func keepsMillisecondsTidy() {
    let odd = MixGrid(origin: 0.5, step: 2, big: 4)
    #expect(odd.line(9, min: 0, max: 100, fallback: 0) == 18.5)
    #expect(MixGrid.tidy(18.499999999) == 18.5)
  }

  @Test func fallsBackWhenNoLineFits() {
    #expect(grid.line(3, min: 1, max: 2, fallback: 7) == 2)
  }
}

@Suite struct MixPointsEditorTests {
  @Test func startsOnTheDetectedPoints() {
    let editor = MixPointsEditor(map: mixMap())
    #expect(editor.shown == (16.5, 176.5))
    #expect(!editor.setByHand(.mixIn))
    #expect(!editor.changed)
    #expect(!editor.anySet)
    #expect(editor.hint == "120 BPM. The markers snap to bars: drag one, or step it a bar or a phrase with its buttons.")
  }

  @Test func showsSavedPointsInOrder() {
    let backwards = MixPointsEditor(map: mixMap(cues: CuePoints(mixIn: 190, mixOut: 30.5)))
    #expect(backwards.shown == (28.5, 30.5))
    #expect(backwards.anySet)
  }

  @Test func dragsToTheNearestBarWithinBounds() {
    var editor = MixPointsEditor(map: mixMap())
    editor.drag(.mixIn, to: 33.2)
    #expect(editor.points.mixIn == 32.5)
    #expect(editor.changed)
    editor.drag(.mixIn, to: 500)
    #expect(editor.points.mixIn == 174.5)  // a bar before mix out
    editor.drag(.mixOut, to: 0)
    #expect(editor.time(.mixOut) == 176.5)  // a bar after mix in: the detected point, so nothing set by hand
    #expect(editor.points.mixOut == nil)
  }

  @Test func stepsABarOrAPhrase() {
    var editor = MixPointsEditor(map: mixMap())
    editor.step(.mixOut, forward: true, phrase: false)
    #expect(editor.points.mixOut == 178.5)
    editor.step(.mixOut, forward: false, phrase: true)
    #expect(editor.points.mixOut == 170.5)
  }

  @Test func forgetsAPointMovedBackOntoTheDetectedOne() {
    var editor = MixPointsEditor(map: mixMap())
    editor.step(.mixIn, forward: true, phrase: false)
    editor.step(.mixIn, forward: false, phrase: false)
    #expect(editor.points.mixIn == nil)
    #expect(!editor.changed)
  }

  @Test func savesAndResets() {
    var editor = MixPointsEditor(map: mixMap(cues: CuePoints(mixIn: 20.5)))
    #expect(editor.setByHand(.mixIn))
    editor.clear()
    #expect(editor.changed)
    #expect(editor.anySet)
    editor.didSave(.init())
    #expect(!editor.anySet)
    #expect(!editor.changed)
  }
}
