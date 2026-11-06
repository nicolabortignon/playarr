import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct AddToPlaylistModelTests {
  let api = FakeAPI()

  func store() async -> PlaylistsStore {
    api.on(.get, "/api/playlists", [
      Listening.summary(Listening.playlist(1, "Mine")), Listening.summary(Listening.playlist(2, "Theirs", mine: false, shared: true)),
    ])
    let store = PlaylistsStore(api: api, queries: QueryCache(directory: nil), toasts: ToastCenter(clock: TestClock()))
    await store.load()
    return store
  }

  @Test func namesWhatItAdds() async {
    let store = await store()
    #expect(AddToPlaylistModel(tracks: [], store: store).title == "New playlist")
    #expect(AddToPlaylistModel(tracks: [Listening.angel], store: store).title == "Add “Angel”")
    #expect(AddToPlaylistModel(tracks: [Listening.angel, Listening.risingson], store: store).title == "Add 2 songs")
  }

  @Test func offersYourOwnPlaylistsOnlyWhenThereAreSongs() async {
    let store = await store()
    let adding = AddToPlaylistModel(tracks: [Listening.angel], store: store)
    #expect(!adding.creating)
    #expect(adding.choices.map(\.name) == ["Mine"])
    let making = AddToPlaylistModel(tracks: [], store: store)
    #expect(making.creating)
    #expect(making.choices.isEmpty)
  }

  @Test func createsOnlyWithAName() async {
    let store = await store()
    let making = AddToPlaylistModel(tracks: [Listening.angel], store: store)
    making.name = "   "
    #expect(!making.canCreate)
    #expect(await making.create() == nil)
    #expect(api.calls(.post, "/api/playlists").isEmpty)
    api.on(.post, "/api/playlists", Listening.playlist(7, "Night", items: [Listening.three[0]]))
    making.name = "Night"
    #expect(await making.create()?.id == 7)
    #expect(api.bodies(.post, "/api/playlists") == [#"{"name":"Night","recordingIds":["rec-700"]}"#])
  }

  @Test func addsToTheChosenPlaylists() async {
    let store = await store()
    api.on(.post, "/api/playlists/1/items", Listening.playlist(1, "Mine", items: [Listening.three[0]]))
    let adding = AddToPlaylistModel(tracks: [Listening.angel], store: store)
    #expect(!adding.canAdd)
    #expect(!(await adding.add()))
    adding.toggle(adding.choices[0])
    #expect(adding.isChosen(adding.choices[0]))
    #expect(adding.addLabel == "Add")
    #expect(await adding.add())
    #expect(api.bodies(.post, "/api/playlists/1/items") == [#"{"recordingIds":["rec-700"]}"#])
  }

  @Test func choosesSeveralAndLetsOneGo() async {
    api.on(.get, "/api/playlists", [1, 2, 3].map { Listening.summary(Listening.playlist($0, "List \($0)")) })
    let store = PlaylistsStore(api: api, queries: QueryCache(directory: nil), toasts: ToastCenter(clock: TestClock()))
    await store.load()
    let adding = AddToPlaylistModel(tracks: [Listening.angel], store: store)
    for playlist in adding.choices { adding.toggle(playlist) }
    #expect(adding.addLabel == "Add to 3 playlists")
    adding.toggle(adding.choices[1])
    #expect(adding.addLabel == "Add to 2 playlists")
    for id in [1, 3] { api.on(.post, "/api/playlists/\(id)/items", Listening.playlist(id, "List \(id)", items: [Listening.three[0]])) }
    #expect(await adding.add())
    #expect(api.calls(.post, "/api/playlists/1/items").count == 1)
    #expect(api.calls(.post, "/api/playlists/2/items").isEmpty)
    #expect(api.calls(.post, "/api/playlists/3/items").count == 1)
  }

  @Test func ticksThePlaylistsHoldingTheSongsAndDashesThoseHoldingSome() async {
    api.on(.get, "/api/playlists", [1, 2, 3].map { Listening.summary(Listening.playlist($0, "List \($0)")) })
    let store = PlaylistsStore(api: api, queries: QueryCache(directory: nil), toasts: ToastCenter(clock: TestClock()))
    await store.load()
    // Angel twice and Risingson: two songs, as the server counts them.
    api.on(.post, "/api/playlists/holding", PlaylistsHolding(holding: ["1": 2, "2": 1]))
    let adding = AddToPlaylistModel(tracks: [Listening.angel, Listening.risingson, Listening.angel], store: store)
    #expect(adding.songs == 2)
    #expect(adding.holds(adding.choices[0]) == .none)
    await adding.loadHolding()
    #expect(api.bodies(.post, "/api/playlists/holding") == [#"{"recordingIds":["rec-700","rec-701","rec-700"]}"#])
    #expect(adding.choices.map(adding.holds) == [.all, .some(1), .none])
    #expect(adding.choices.map(adding.note) == ["already in it", "1 of 2 already in it", nil])
  }

  @Test func withoutAnAnswerThereAreNoTicks() async {
    let store = await store()
    api.fail(.post, "/api/playlists/holding", status: 500, "Something broke")
    let adding = AddToPlaylistModel(tracks: [Listening.angel], store: store)
    await adding.loadHolding()
    #expect(adding.holds(adding.choices[0]) == .none)
    // Making a new playlist from nothing doesn't ask.
    let making = AddToPlaylistModel(tracks: [], store: store)
    await making.loadHolding()
    #expect(api.calls(.post, "/api/playlists/holding").count == 1)
  }
}
