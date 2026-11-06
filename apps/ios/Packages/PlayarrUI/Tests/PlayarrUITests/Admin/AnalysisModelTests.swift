import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct AnalysisModelTests {
  let api = FakeAPI()
  let clock = TestClock()

  static func progress(enabled: Bool = true, beats: Int = 4000, waiting: Int = 0, working: Int = 0, scan: Bool = false) -> AnalysisProgress {
    AnalysisProgress(
      enabled: enabled, songs: 5678, beats: .init(ready: beats, beatModel: beats - 10, failed: 78), sound: .init(ready: 5678, failed: 0),
      loudness: .init(ready: 5000, failed: 2), tags: .init(ready: 100, songs: 5000), waiting: waiting, working: working,
      loudnessWaiting: 0, loudnessWorking: 0, tagsWaiting: 0, libraryScan: scan)
  }

  func model() -> AnalysisModel {
    api.on(.get, "/api/settings/mixes", MixesTests.settings())
    return AnalysisModel(api: api, clock: clock)
  }

  @Test func saysHowFarEachAnalysisHasGot() async {
    let analysis = model()
    api.on(.get, "/api/analysis/progress", Self.progress())
    await analysis.load()
    let rows = analysis.rows
    #expect(rows.map(\.title) == ["Beat analysis", "Sound analysis", "Loudness analysis", "Tag lookup"])
    #expect(rows[0].text == "Ready for DJ mix: 4,000 of 5,678 songs (10 without the beat model) · 78 couldn’t be analyzed. Others are analyzed as they come up to play.")
    #expect(rows[0].leftLabel == "Analyze the 1,600 of 5,678 songs left")
    #expect(rows[0].showsBar)
    #expect(rows[1].text == "All 5,678 songs are measured." && rows[1].leftLabel == nil && !rows[1].showsBar)
    #expect(rows[2].text == "Measured: 5,000 of 5,678 songs · 2 couldn’t be measured. The others play at their own volume until they are.")
    #expect(rows[3].text == "Looked up: 100 of 5,000 songs matched on MusicBrainz (678 more aren’t matched on MusicBrainz).")
    #expect(rows[3].leftLabel == "Look up the 4,900 of 5,000 songs left")
    #expect(rows[3].againQuestion == "Look up the entire collection again?")
    #expect(analysis.queueText == "Nothing is being analyzed right now.")
  }

  @Test func offersOnlyTagsWithoutAudioAnalysis() async {
    let analysis = model()
    api.on(.get, "/api/analysis/progress", Self.progress(enabled: false))
    await analysis.load()
    #expect(analysis.rows[0].text == "DJ mix needs it. Audio analysis is off on this server (set ANALYSIS=on in its .env).")
    #expect(!analysis.rows[0].canRun && analysis.rows[0].leftLabel == nil)
    #expect(analysis.rows[3].canRun)
    #expect(!analysis.analyzeLibraryShown)
    #expect(AnalysisText.everythingExplain(audio: false).hasPrefix("A tag lookup for every song"))
  }

  @Test func pollsEvery10SecondsWhileSongsAreUnderWay() async {
    let analysis = model()
    api.on(.get, "/api/analysis/progress", Self.progress(waiting: 12, working: 1))
    api.then(.get, "/api/analysis/progress", Self.progress())
    let polling = Task { await analysis.poll() }
    #expect(await clock.nextSleep() == .seconds(10))
    #expect(analysis.queueText == "Now: analyzing 1 song · 12 waiting for beat or sound analysis.")
    clock.advance(by: .seconds(10))
    #expect(await clock.nextSleep() == .seconds(60))
    polling.cancel()
  }

  @Test func runsTheSongsLeftOrEverySongAgain() async {
    let analysis = model()
    api.on(.get, "/api/analysis/progress", Self.progress())
    await analysis.load()
    api.on(.post, "/api/analysis/beats", json: #"{"queued":1600}"#)
    await analysis.run(.beats)
    #expect(api.bodies(.post, "/api/analysis/beats") == [#"{"again":false}"#])
    #expect(analysis.notice == "Analyzing 1,600 songs in the background")
    api.on(.post, "/api/analysis/all", json: #"{"queued":5678}"#)
    await analysis.run(nil, again: true)
    #expect(api.bodies(.post, "/api/analysis/all") == [#"{"again":true}"#])
    #expect(analysis.notice == "Analyzing 5,678 songs again in the background")
    api.on(.post, "/api/analysis/tags", json: #"{"queued":0}"#)
    await analysis.run(.tags)
    #expect(analysis.notice == "Every song is already looked up or waiting its turn")
  }

  @Test func turnsOnAnalysingTheWholeLibrary() async {
    let analysis = model()
    api.on(.get, "/api/analysis/progress", Self.progress())
    await analysis.load()
    #expect(analysis.analyzeLibrary == false)
    var on = MixesTests.settings()
    on.analyzeLibrary = true
    api.on(.put, "/api/settings/mixes", on)
    await analysis.setAnalyzeLibrary(true)
    #expect(api.bodies(.put, "/api/settings/mixes") == [#"{"analyzeLibrary":true}"#])
    #expect(analysis.analyzeLibraryShown)
  }
}
