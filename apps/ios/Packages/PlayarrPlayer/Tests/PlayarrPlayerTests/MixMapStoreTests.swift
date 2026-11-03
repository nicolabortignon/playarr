import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrPlayer

@MainActor
struct MixMapStoreTests {
  final class Server: Sendable {
    let asked = Mutex<[[String]]>([])
    let version = Mutex(7)
    func maps(_ ids: [String]) -> [String: MixMapEntry] {
      asked.withLock { $0.append(ids) }
      let v = version.withLock { $0 }
      return Dictionary(uniqueKeysWithValues: ids.filter { $0 != "rec-9" }.map { ($0, Self.map(version: v)) })
    }
    static func map(version: Int) -> MixMapEntry {
      MixMapEntry(
        version: version, duration: 200, bpm: 120, firstBeat: 0.1, downbeatOffset: 0, gridStable: true, beatConfidence: 0.9,
        introEnd: 16, outroStart: 180, coldStart: false, coldEnd: false, soundEnd: 199, phraseEnergy: [0.5, nil, 1])
    }
  }

  let clock = ManualScheduling()
  let server = Server()

  func store() -> MixMapStore {
    let server = self.server
    return MixMapStore(scheduler: clock) { server.maps($0) }
  }

  /// Lets the polls' tasks run.
  func settle() async { for _ in 0..<20 { await Task.yield() } }

  @Test func thePlayerAsksAgainForASongAfterAMinute() async {
    let maps = store()
    await maps.load([song(1), song(2), song(1), nil])
    #expect(server.asked.withLock { $0 } == [["rec-1", "rec-2"]])
    #expect(maps.map("rec-1")?.bpm == 120)
    clock.advance(by: 59)
    await maps.load([song(1)])
    #expect(server.asked.withLock { $0.count } == 1)
    clock.advance(by: 2)
    await maps.load([song(1)])
    #expect(server.asked.withLock { $0.count } == 2)
  }

  @Test func asksForFiftyAtATime() async {
    let maps = store()
    await maps.load((1...120).map { song($0 + 100) })
    #expect(server.asked.withLock { $0.map(\.count) } == [50, 50, 20])
  }

  @Test func whatIsOnScreenIsAskedEveryThirtySecondsTenTimesAtMostWhileNotCurrent() async {
    let maps = store()
    maps.watch(["rec-1", "rec-9"])
    await settle()
    #expect(server.asked.withLock { $0.count } == 1)
    for _ in 0..<20 {
      clock.advance(by: 30)
      await settle()
    }
    #expect(server.asked.withLock { $0.count } == MixMapStore.polls)
  }

  @Test func stopsAskingOnceEveryMapIsCurrent() async {
    let maps = store()
    maps.watch(["rec-1"])
    await settle()
    server.version.withLock { $0 = mixMapVersion }
    clock.advance(by: 30)
    await settle()
    #expect(maps.map("rec-1")?.version == mixMapVersion)
    clock.advance(by: 300)
    await settle()
    #expect(server.asked.withLock { $0.count } == 2)
  }

  @Test func anotherListStartsOverAndForgetAsksAfresh() async {
    let maps = store()
    maps.watch(["rec-1"])
    await settle()
    maps.watch(["rec-1"])
    await settle()
    #expect(server.asked.withLock { $0.count } == 1)
    maps.forget("rec-1")
    await maps.load([song(1)])
    #expect(server.asked.withLock { $0.count } == 2)
  }
}
