import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrPlayer

@MainActor
struct LevelStoreTests {
  final class Server: Sendable {
    let requests = Mutex<[[String]]>([])
    let failing = Mutex(false)
    func levels(_ ids: [String]) throws -> [String: TrackLevel] {
      requests.withLock { $0.append(ids) }
      if failing.withLock({ $0 }) { throw URLError(.notConnectedToInternet) }
      return Dictionary(uniqueKeysWithValues: ids.filter { $0 != "rec-9" }.map { ($0, TrackLevel(track: -4, album: -2)) })
    }
  }

  @Test func asksOnceForWhatItDoesNotKnowAndAgainAfterFifteenSeconds() async {
    let server = Server()
    var clock = Date(timeIntervalSince1970: 0)
    let store = LevelStore(now: { clock }) { try server.levels($0) }
    await store.load([song(1), song(9), song(1), nil])
    #expect(server.requests.withLock { $0 } == [["rec-1", "rec-9"]])
    #expect(store.levels["rec-1"]?.track == -4)
    await store.load([song(1), song(9)])
    #expect(server.requests.withLock { $0.count } == 1)  // rec-9 was asked just now
    clock += 16
    await store.load([song(1), song(9)])
    #expect(server.requests.withLock { $0.last } == ["rec-9"])
  }

  @Test func asksAtMostFiftyAtATime() async {
    let server = Server()
    let store = LevelStore { try server.levels($0) }
    await store.load((1...120).map { song($0 + 100) })
    #expect(server.requests.withLock { $0.map(\.count) } == [50, 50, 20])
  }

  @Test func aFailedRequestIsAskedAgainAtOnce() async {
    let server = Server()
    server.failing.withLock { $0 = true }
    let store = LevelStore { try server.levels($0) }
    await store.load([song(1)])
    server.failing.withLock { $0 = false }
    await store.load([song(1)])
    #expect(store.levels["rec-1"] != nil)
  }

  @Test func theGainIsTheAlbumsWithinAnAlbumAndNoneWhenOff() async {
    let server = Server()
    let store = LevelStore { try server.levels($0) }
    var q = QueueState()
    q.playTracks([song(1), song(2), song(3, albumId: 2)])
    await store.load(q.queue)
    #expect(store.gainDb(for: q.queue[0], in: q, enabled: true) == -2)
    #expect(store.gainDb(for: q.queue[2], in: q, enabled: true) == -4)
    #expect(store.gainDb(for: q.queue[0], in: q, enabled: false) == nil)
    #expect(store.gainDb(for: song(9), in: q, enabled: true) == nil)
  }
}
