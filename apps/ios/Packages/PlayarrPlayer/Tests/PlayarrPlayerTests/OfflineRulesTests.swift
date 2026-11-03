import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// A kept song's record: `bytes` long, last used `usedAt` seconds into 2001.
func kept(_ bytes: Int64, usedAt: TimeInterval = 0, file: String = "stream/x.flac") -> KeptFile {
  KeptFile(file: file, bytes: bytes, usedAt: Date(timeIntervalSinceReferenceDate: usedAt))
}

/// A long blend starting 170 s into A, as the server plans one.
let longPlan = TransitionPlan(
  style: .long, aStart: 170, bStart: 8, length: 24, bResume: 32, switchAt: 12, bRate: [], aGain: [], bGain: [], aLowDb: [],
  bLowDb: [], aHighPassHz: [], reason: "phrase", beats: 32)

/// A ready transition answer from `from` to `to`, with B's remainder when `rest`.
func ready(_ from: Int, _ to: Int, rest: Bool = false) -> TransitionAnswer.Ready {
  TransitionAnswer.Ready(
    plan: longPlan, url: "/transitions/\(from)-\(to).flac", continuationUrl: rest ? "/transitions/\(from)-\(to).rest.flac" : nil,
    tail: 3, lead: 3)
}

struct OfflineRulesTests {
  let songs: [Int: KeptFile] = [1: kept(400, usedAt: 30), 2: kept(400, usedAt: 10), 3: kept(400, usedAt: 20)]

  @Test func dropsTheLeastRecentlyUsedUntilTheNewSongFits() {
    #expect(OfflineRules.evictions(songs, need: 100, limit: 2000) == [])
    #expect(OfflineRules.evictions(songs, need: 500, limit: 1500) == [2])
    #expect(OfflineRules.evictions(songs, need: 900, limit: 1500) == [2, 3])
  }

  @Test func neverDropsProtectedSongsAndGivesUpWhenItCannotFit() {
    #expect(OfflineRules.evictions(songs, need: 500, limit: 1500, protect: [2]) == [3])
    #expect(OfflineRules.evictions(songs, need: 1000, limit: 1500, protect: [1, 3]) == nil)
    #expect(OfflineRules.evictions([:], need: 2000, limit: 1500) == nil)
    #expect(OfflineRules.freeUp(songs, bytes: 500) == [2, 3])
    #expect(OfflineRules.freeUp(songs, bytes: 500, protect: [3]) == [2, 1])
    #expect(OfflineRules.freeUp(songs, bytes: 5000) == nil)
  }

  @Test func downloadsSongsAreOutsideTheLimit() {
    let album = PinnedDownload(key: "album:1", title: "Dummy", href: "/albums/1", tracks: [song(1), song(2)])
    #expect(OfflineRules.unpinned(songs, pins: ["album:1": album]).keys.sorted() == [3])
    var withTransition = album
    withTransition.transitions[OfflineRules.pair(1, 2, .auto)] = KeptTransition(answer: ready(1, 2, rest: true), levelled: true)
    #expect(OfflineRules.pinnedTransitionFiles(["album:1": withTransition]) == ["1-2.flac", "1-2.rest.flac"])
  }

  @Test func countsADownloadsProgressWithItsTransitions() {
    var album = PinnedDownload(key: "album:1", title: "Dummy", href: "/albums/1", tracks: [song(1), song(2), song(9)])
    album.transitions["1-2-auto"] = KeptTransition(answer: ready(1, 2), levelled: false)
    let manifest = OfflineManifest(songs: songs, transitionFiles: ["1-2.flac": kept(50)], pins: ["album:1": album])
    #expect(OfflineRules.progress(of: album, in: manifest) == DownloadProgress(done: 2, total: 3, bytes: 850))
  }

  @Test func fetchesDownloadsInTheOrderTheyWereAddedSkippingWhatFailed() {
    let pins = [
      "b": PinnedDownload(key: "b", title: "B", href: "/b", tracks: [song(8)], addedAt: Date(timeIntervalSinceReferenceDate: 2)),
      "a": PinnedDownload(key: "a", title: "A", href: "/a", tracks: [song(1), song(2)], addedAt: Date(timeIntervalSinceReferenceDate: 1)),
    ]
    #expect(OfflineRules.nextToDownload(pins, songs: [:])?.fileId == 1)
    #expect(OfflineRules.nextToDownload(pins, songs: [1: kept(1)], skip: [2])?.fileId == 8)
    #expect(OfflineRules.nextToDownload(pins, songs: [1: kept(1), 2: kept(1), 8: kept(1)]) == nil)
  }

  @Test func asksForEachPairInSongOrderOnceBothSongsAreHere() {
    let album = PinnedDownload(key: "album:1", title: "Dummy", href: "/albums/1", tracks: [song(4), song(5), song(6)])
    var m = OfflineManifest(songs: [4: kept(1), 5: kept(1)], pins: ["album:1": album])
    #expect(OfflineRules.nextTransition(m.pins, manifest: m).map { [$0.from.fileId, $0.to.fileId] } == [4, 5])
    #expect(OfflineRules.nextTransition(m.pins, manifest: m, skipped: ["4-5-auto"]) == nil)  // 6 isn't here yet
    m.songs[6] = kept(1)
    m.pins["album:1"]?.transitions["4-5-auto"] = KeptTransition(answer: ready(4, 5), levelled: false)
    m.transitionFiles["4-5.flac"] = kept(1)
    #expect(OfflineRules.nextTransition(m.pins, manifest: m).map { [$0.from.fileId, $0.to.fileId] } == [5, 6])
    // The player is asking about song 5 into another song: that pair waits.
    #expect(OfflineRules.nextTransition(m.pins, manifest: m, busy: { from, _ in from.fileId == 5 }) == nil)
  }

  @Test func namesTransitionFilesByTheServersContentKeys() {
    #expect(KeptTransition.fileName("/transitions/abc.flac") == "abc.flac")
    #expect(KeptTransition.fileName("/transitions/abc.rest.flac?v=2") == "abc.rest.flac")
    #expect(OfflineRules.pairs(of: [song(1), song(2), song(3)], mode: .auto) == ["1-2-auto", "2-3-auto"])
    #expect(OfflineRules.playsAlbum("/albums/1", song(3)))
    #expect(!OfflineRules.playsAlbum("/playlists/1", song(3)))
  }

  @Test func theManifestGoesToDiskAndBack() throws {
    var album = PinnedDownload(key: "album:1", title: "Dummy", href: "/albums/1", tracks: [song(1)], levels: ["rec-1": TrackLevel(track: -3)])
    album.transitions["1-2-auto"] = KeptTransition(answer: ready(1, 2), levelled: true)
    let manifest = OfflineManifest(songs: [1: kept(10)], transitionFiles: ["1-2.flac": kept(5)], pins: ["album:1": album])
    let file = JSONFile<OfflineManifest>(temporaryDirectory().appending(path: "offline.json"))
    file.write(manifest)
    #expect(file.read() == manifest)
  }
}
