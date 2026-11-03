import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

struct KeepAheadTests {
  func at(_ pos: Int, _ repeatMode: RepeatMode = .off, order: [Int] = [0, 1, 2, 3, 4], songs: [Int] = [1, 2, 3, 4, 5]) -> QueueState {
    var q = QueueState()
    q.queue = songs.map { song($0) }
    q.order = order
    q.pos = pos
    q.repeatMode = repeatMode
    return q
  }

  func ids(_ tracks: [Track]) -> [Int] { tracks.map(\.fileId) }

  @Test func takesTheNextSongsInPlayOrderThenTheOnePlaying() {
    #expect(ids(KeepAhead.plan(at(0), ahead: 3, withCurrent: true)) == [2, 3, 4, 1])
    #expect(ids(KeepAhead.plan(at(1, order: [4, 2, 0, 1, 3]), ahead: 2, withCurrent: true)) == [1, 2, 3])
  }

  @Test func stopsAtTheEndOfTheQueueUnlessItRepeats() {
    #expect(ids(KeepAhead.plan(at(3), ahead: 3, withCurrent: true)) == [5, 4])
    #expect(ids(KeepAhead.plan(at(3, .all), ahead: 3, withCurrent: true)) == [5, 1, 2, 4])
  }

  @Test func putsTheCurrentSongFirstOnRepeatOneAndLeavesItOutOnRequest() {
    #expect(ids(KeepAhead.plan(at(0, .one), ahead: 1, withCurrent: false)) == [1, 2])
    #expect(ids(KeepAhead.plan(at(0), ahead: 1, withCurrent: false)) == [2])
  }

  @Test func listsEachFileOnceAndNothingForAnEmptyQueue() {
    #expect(ids(KeepAhead.plan(at(0, order: [0, 1, 2], songs: [7, 8, 7]), ahead: 3, withCurrent: true)) == [8, 7])
    #expect(KeepAhead.plan(QueueState(), ahead: 3, withCurrent: true).isEmpty)
  }

  @Test func looksAheadByTheNetworkAndNotAtAllWhenKeepingIsOff() {
    let gb = OfflineLimit.gigabyte
    #expect(ids(KeepAhead.plan(at(0), network: .wifi, limit: gb)) == [2, 3, 4, 1])
    #expect(ids(KeepAhead.plan(at(0), network: .cellular, limit: gb)) == [2])
    #expect(KeepAhead.plan(at(0), network: .constrained, limit: gb).isEmpty)
    #expect(KeepAhead.plan(at(0), network: .offline, limit: gb).isEmpty)
    #expect(KeepAhead.plan(at(0), network: .wifi, limit: 0).isEmpty)
  }
}

struct OfflinePlaybackTests {
  @Test func findsTheNextSongOnThisDeviceWithoutWrappingRound() {
    var q = QueueState()
    q.playTracks((1...5).map { song($0) }, startIndex: 1)
    #expect(OfflinePlayback.nextKept(in: q, isKept: { [4, 1].contains($0) }) == 3)
    #expect(OfflinePlayback.nextKept(in: q, isKept: { $0 == 1 }) == nil)
  }

  @Test func usesAKeptTransitionOfflineAlwaysAndOnlineWhileItsMixPointIsWellAhead() {
    let kept = KeptTransitionFiles(transition: KeptTransition(answer: ready(1, 2), levelled: false), file: URL(filePath: "/t.flac"), continuation: nil)
    #expect(OfflinePlayback.useKept(kept, online: false, time: 169) == kept)  // aStart is 170
    #expect(OfflinePlayback.useKept(kept, online: true, time: 100) == kept)
    #expect(OfflinePlayback.useKept(kept, online: true, time: 151) == nil)
    #expect(OfflinePlayback.useKept(nil, online: false, time: 0) == nil)
  }
}
