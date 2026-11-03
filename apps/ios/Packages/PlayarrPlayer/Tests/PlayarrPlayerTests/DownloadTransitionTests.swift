import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

@MainActor
@Suite(.serialized)
struct DownloadTransitionTests {
  /// A rig on DJ mix with these answers, and the album's songs downloaded.
  func rig(_ answers: [String: [TransitionAnswer]], songs: [Int] = [4, 5, 6]) async -> StoreRig {
    let rig = StoreRig()
    rig.settings.transitions = .dj
    rig.backend.transitionAnswers.withLock { $0 = answers }
    rig.store.add(album(songs))
    for id in songs { await rig.finish(id) }
    return rig
  }

  func transitionJob(_ rig: StoreRig, _ name: String) -> String { rig.folder.jobID("offline/transitions/\(name)") }

  /// Waits for a transition file's job, then finishes it.
  func finish(_ rig: StoreRig, _ name: String) async {
    let id = transitionJob(rig, name)
    await eventually { rig.transport.runningIDs.contains(id) }
    rig.transport.finish(id, bytes: 100)
    await eventually { rig.store.manifest.transitionFiles[name] != nil }
  }

  @Test func asksForEachPairInSongOrderAsThePlayerWouldAndKeepsTheFiles() async {
    let rig = await rig(["4-5": [.pending(.init(plan: longPlan)), .ready(ready(4, 5))], "5-6": [.ready(ready(5, 6, rest: true))]])
    await finish(rig, "4-5.flac")
    await finish(rig, "5-6.flac")
    await finish(rig, "5-6.rest.flac")
    await eventually { rig.store.manifest.pins["album:1"]?.transitions.count == 2 }
    let asks = rig.backend.transitionAsks.all
    #expect(asks.map { [$0.from, $0.to] } == [[4, 5], [4, 5], [5, 6]])
    #expect(asks[0] == TransitionRequest(from: 4, to: 5, mode: .auto, fromFileId: 4, toFileId: 5, fade: 6, albumQueue: true))
    #expect(rig.store.progress(of: "album:1")?.bytes == 3300)  // three songs and three transition files
  }

  @Test func looksAKeptTransitionUpByItsPairModeAndGains() async {
    let rig = await rig(["4-5": [.ready(ready(4, 5, rest: true))]], songs: [4, 5])
    await finish(rig, "4-5.flac")
    await finish(rig, "4-5.rest.flac")
    await eventually { rig.store.manifest.pins["album:1"]?.transitions.count == 1 }
    let kept = rig.store.keptTransition(from: song(4), to: song(5), mode: .auto, online: false, levelled: false)
    #expect(kept?.file == rig.folder.transitions.appending(path: "4-5.flac"))
    #expect(kept?.continuation == rig.folder.transitions.appending(path: "4-5.rest.flac"))
    #expect(kept?.transition.answer == ready(4, 5, rest: true))
    // Made without even volume's gains: not for songs played levelled.
    #expect(rig.store.keptTransition(from: song(4), to: song(5), mode: .auto, online: false, levelled: true) == nil)
    // Offline a Party queue takes the Auto one; online it asks the server.
    #expect(rig.store.keptTransition(from: song(4), to: song(5), mode: .party, online: false, levelled: false) != nil)
    #expect(rig.store.keptTransition(from: song(4), to: song(5), mode: .party, online: true, levelled: false) == nil)
    // Its files gone: none.
    rig.folder.remove("offline/transitions/4-5.rest.flac")
    rig.store.removeAll()
    #expect(rig.store.keptTransition(from: song(4), to: song(5), mode: .auto, online: false, levelled: false) == nil)
  }

  @Test func skipsPairsWithNoTransitionToKeepAndMovesOn() async {
    let rig = await rig(["5-6": [.straight(.init(plan: longPlan))]])  // 4-5: unavailable
    await eventually { rig.store.skippedPairs.count == 2 }
    #expect(rig.store.skippedPairs == ["4-5-auto": "No mix map yet", "5-6-auto": "No transition: the songs play straight on"])
    #expect(rig.store.manifest.transitionFiles.isEmpty)
  }

  @Test func givesUpOnAPairThatTakesTooLongToRender() async {
    let rig = await rig(["4-5": [.pending(.init(plan: longPlan))], "5-6": [.ready(ready(5, 6))]], songs: [4, 5, 6])
    await finish(rig, "5-6.flac")
    #expect(rig.store.skippedPairs["4-5-auto"] == "The transition took too long to render")
  }

  @Test func sharesATransitionBetweenDownloadsAndRemovesItsFilesWithTheLastOne() async {
    let rig = await rig(["4-5": [.ready(ready(4, 5))], "5-6": [.ready(ready(5, 6, rest: true))]])
    await finish(rig, "4-5.flac")
    await finish(rig, "5-6.flac")
    await finish(rig, "5-6.rest.flac")
    rig.store.add(key: "playlist:1", title: "Two", href: "/playlists/1", tracks: [song(4), song(5)])
    await eventually { rig.store.manifest.pins["playlist:1"]?.transitions.count == 1 }
    #expect(rig.backend.transitionAsks.all.count == 2)  // not asked again
    rig.store.remove("album:1")
    #expect(rig.folder.transitionFiles().keys.sorted() == ["4-5.flac"])
    rig.store.remove("playlist:1")
    #expect(rig.folder.transitionFiles().isEmpty)
    #expect(rig.store.manifest.transitionFiles.isEmpty)
  }

  @Test func forgetsTransitionsOfPairsADownloadNoLongerHas() async {
    let rig = await rig(["4-5": [.ready(ready(4, 5))], "5-6": [.ready(ready(5, 6))]])
    await finish(rig, "4-5.flac")
    await finish(rig, "5-6.flac")
    await eventually { rig.store.manifest.pins["album:1"]?.transitions.count == 2 }
    rig.store.add(album([4, 5]))
    #expect(rig.store.manifest.pins["album:1"]?.transitions.keys.sorted() == ["4-5-auto"])
    #expect(rig.folder.transitionFiles().keys.sorted() == ["4-5.flac"])
  }

  @Test func leavesThePairThePlayerIsAskingAboutToThePlayer() async {
    let rig = StoreRig()
    rig.settings.transitions = .dj
    rig.store.playerPair = { (fromFileId: 4, toFileId: 9) }  // song 4 plays with song 9 next
    rig.backend.transitionAnswers.withLock { $0 = ["4-5": [.ready(ready(4, 5))], "5-6": [.ready(ready(5, 6))]] }
    rig.store.add(album([4, 5, 6]))
    for id in [4, 5, 6] { await rig.finish(id) }
    await finish(rig, "5-6.flac")
    #expect(rig.backend.transitionAsks.all.map { [$0.from, $0.to] } == [[5, 6]])
    rig.store.playerPair = { nil }
    rig.store.playerMoved()
    await finish(rig, "4-5.flac")
  }

  @Test func fetchesNothingUnlessTransitionsAreDJMix() async {
    let rig = StoreRig()
    rig.settings.transitions = .crossfade
    rig.store.add(album([4, 5]))
    for id in [4, 5] { await rig.finish(id) }
    try? await Task.sleep(for: .milliseconds(30))
    #expect(rig.backend.transitionAsks.all.isEmpty)
    rig.backend.transitionAnswers.withLock { $0 = ["4-5": [.ready(ready(4, 5))]] }
    rig.settings.transitions = .dj  // downloads made before fetch theirs now
    await finish(rig, "4-5.flac")
  }

  @Test func asksAtTheGainsEvenVolumePlaysTheSongsAt() async {
    let rig = StoreRig()
    rig.settings.transitions = .dj
    rig.backend.levelTable.withLock { $0 = ["rec-4": TrackLevel(track: -5, album: -3), "rec-5": TrackLevel(track: 2, album: -3)] }
    rig.backend.transitionAnswers.withLock { $0 = ["4-5": [.ready(ready(4, 5))]] }
    rig.store.add(album([4, 5]))
    await eventually { rig.store.keptLevels.count == 2 }
    for id in [4, 5] { await rig.finish(id) }
    await finish(rig, "4-5.flac")
    await eventually { rig.store.manifest.pins["album:1"]?.transitions.count == 1 }
    #expect(rig.backend.transitionAsks.all.first?.levels == .init(a: -3, b: -3))  // the album's gain: it plays in order
    #expect(rig.store.keptTransition(from: song(4), to: song(5), mode: .auto, online: false, levelled: true) != nil)
  }
}
