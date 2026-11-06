import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct PlaylistsStoreTests {
  let api = FakeAPI()
  let toasts = ToastCenter(clock: TestClock())

  func store(clock: any Clock<Duration> = ContinuousClock()) -> PlaylistsStore {
    PlaylistsStore(api: api, queries: QueryCache(directory: nil), toasts: toasts, clock: clock)
  }

  @Test func offersOnlyYourOwnToAddTo() async {
    let mine = Listening.summary(Listening.playlist(1, "Mine"))
    let theirs = Listening.summary(Listening.playlist(2, "Theirs", mine: false, shared: true, owner: "Sam"))
    api.on(.get, "/api/playlists", [theirs, mine])
    let store = store()
    await store.load()
    #expect(store.playlists?.map(\.name) == ["Theirs", "Mine"])
    #expect(store.mine.map(\.name) == ["Mine"])
  }

  @Test func createsWithTheSongsAndSaysSo() async {
    let made = Listening.playlist(9, "Night", items: Array(Listening.three.prefix(2)))
    api.on(.post, "/api/playlists", made)
    api.on(.get, "/api/playlists", [Listening.summary(made)])
    let store = store()
    #expect(await store.create(name: "Night", tracks: [Listening.angel, Listening.risingson])?.id == 9)
    #expect(api.bodies(.post, "/api/playlists") == [#"{"name":"Night","recordingIds":["rec-700","rec-701"]}"#])
    #expect(store.playlists?.map(\.id) == [9])
    api.on(.post, "/api/playlists", Listening.playlist(10, "Empty"))
    _ = await store.create(name: "Empty")
    #expect(api.bodies(.post, "/api/playlists").last == #"{"name":"Empty"}"#)
    #expect(toasts.toasts.map(\.message) == ["Created “Night” with 2 songs", "Created “Empty”"])
  }

  @Test func addsSongsAndSaysWhere() async {
    api.on(.post, "/api/playlists/5/items", Listening.playlist(items: [Listening.three[0]]))
    api.on(.get, "/api/playlists", json: "[]")
    let store = store()
    _ = await store.add([Listening.angel], to: 5)
    _ = await store.add([Listening.angel, Listening.risingson], to: 5)
    #expect(api.bodies(.post, "/api/playlists/5/items").first == #"{"recordingIds":["rec-700"]}"#)
    #expect(toasts.toasts.map(\.message) == ["Added “Angel” to “Road trip”", "Added 2 songs to “Road trip”"])
  }

  @Test func addsToSeveralAtOnceAndNamesThem() async {
    api.on(.post, "/api/playlists/5/items", Listening.playlist(5, "Road trip", items: [Listening.three[0]]))
    api.on(.post, "/api/playlists/6/items", Listening.playlist(6, "Late night", items: [Listening.three[0]]))
    api.on(.post, "/api/playlists/7/items", Listening.playlist(7, "Sunday", items: [Listening.three[0]]))
    api.on(.get, "/api/playlists", json: "[]")
    let store = store()
    #expect(await store.add([Listening.angel], to: [6, 5]).map(\.id) == [6, 5])
    #expect(await store.add([Listening.angel, Listening.risingson], to: [5, 6, 7]).count == 3)
    #expect(api.calls(.post, "/api/playlists/7/items").count == 1)
    #expect(toasts.toasts.map(\.message) == ["Added “Angel” to “Late night” and “Road trip”", "Added 2 songs to 3 playlists"])
  }

  @Test func saysWhichPlaylistsDidntTakeTheSongs() async {
    api.on(.post, "/api/playlists/5/items", Listening.playlist(5, "Road trip", items: [Listening.three[0]]))
    api.fail(.post, "/api/playlists/6/items", status: 403, "Only the playlist's owner can change it")
    api.fail(.post, "/api/playlists/7/items", status: 403, "Only the playlist's owner can change it")
    api.on(.get, "/api/playlists", json: "[]")
    let store = store()
    #expect(await store.add([Listening.angel], to: [5, 6]).map(\.id) == [5])
    #expect(toasts.toasts.map(\.message) == ["Added “Angel” to “Road trip”", "Only the playlist's owner can change it"])
    #expect(await store.add([Listening.angel], to: [6, 7]).isEmpty)
    #expect(toasts.toasts.last?.message == "Couldn’t add to 2 playlists: Only the playlist's owner can change it")
    #expect(toasts.toasts.last?.tone == .error)
  }

  @Test func pollsEveryFourSecondsWhileACoverIsDrawn() async {
    let clock = TestClock()
    api.on(.get, "/api/playlists", [Listening.summary(Listening.playlist(pending: true))])
    api.then(.get, "/api/playlists", [Listening.summary(Listening.playlist(pending: false))])
    let store = store(clock: clock)
    let polling = Task { await store.poll() }
    #expect(await clock.nextSleep() == .seconds(4))
    clock.advance(by: .seconds(4))
    await polling.value
    #expect(api.calls(.get, "/api/playlists").count == 2)
    #expect(store.playlists?.first?.cover.pending == false)
  }
}
