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

  @Test func addsToAnExistingPlaylist() async {
    let store = await store()
    api.on(.post, "/api/playlists/1/items", Listening.playlist(1, "Mine", items: [Listening.three[0]]))
    let adding = AddToPlaylistModel(tracks: [Listening.angel], store: store)
    #expect(await adding.add(to: adding.choices[0]))
  }
}
