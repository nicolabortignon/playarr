import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct AlbumsModelTests {
  /// The albums with these ids, as a server lists them.
  func albums(_ ids: ClosedRange<Int>) -> [Album] {
    ids.map {
      Album(
        id: $0, title: "Album \($0)", artistId: 1, artistName: "Artist", albumType: "Album", secondaryTypes: [], genres: [], duration: 2400,
        trackCount: 10, totalTrackCount: 10)
    }
  }

  @Test func asksForTheSortChosen() async {
    let api = FakeAPI.demoLibrary()
    let model = AlbumsModel(session: demoSession(api: api), sort: .artist)
    await model.load()
    model.sort = .added
    await model.load()
    #expect(model.first.key == .albums(.added))
    #expect(model.albums?.count == 3)
    #expect(api.queries(.get, "/api/albums", "sort") == ["artist", "added"])
  }

  @Test func readsTheFirstPageThenTheNextAsTheListNearsItsEnd() async {
    let api = FakeAPI()
    api.on(.get, "/api/albums", AlbumPage(albums: albums(1...2), total: 3, version: "v1"))
    api.then(.get, "/api/albums", AlbumPage(albums: albums(3...3), total: 3, version: "v1"))
    let model = AlbumsModel(session: demoSession(api: api), sort: .artist)
    await model.load()
    #expect(model.albums?.map(\.id) == [1, 2])
    #expect(model.total == 3)
    #expect(model.hasMore)
    await model.loadMore()
    #expect(model.albums?.map(\.id) == [1, 2, 3])
    #expect(!model.hasMore)
    #expect(api.queries(.get, "/api/albums", "offset") == ["0", "2"])
    #expect(api.queries(.get, "/api/albums", "limit") == ["120", "120"])
    // Nothing left to read: no more asking.
    await model.loadMore()
    #expect(api.calls(.get, "/api/albums").count == 2)
  }

  @Test func startsAgainWhenTheLibraryChangedMidway() async {
    let api = FakeAPI()
    api.on(.get, "/api/albums", AlbumPage(albums: albums(1...2), total: 4, version: "v1"))
    api.then(.get, "/api/albums", AlbumPage(albums: albums(3...4), total: 4, version: "v2"))
    api.then(.get, "/api/albums", AlbumPage(albums: albums(5...6), total: 5, version: "v2"))
    let model = AlbumsModel(session: demoSession(api: api), sort: .artist)
    await model.load()
    await model.loadMore()
    // The second page came from another library: the pages before it may have moved.
    #expect(model.albums?.map(\.id) == [5, 6])
    #expect(model.total == 5)
    #expect(api.queries(.get, "/api/albums", "offset") == ["0", "2", "0"])
  }

  @Test func offersToAskAgainForAPageThatDidntCome() async {
    let api = FakeAPI()
    api.on(.get, "/api/albums", AlbumPage(albums: albums(1...2), total: 3, version: "v1"))
    let model = AlbumsModel(session: demoSession(api: api), sort: .artist)
    await model.load()
    api.fail(.get, "/api/albums", status: 503, "Offline")
    await model.loadMore()
    #expect(model.moreFailed)
    #expect(model.albums?.map(\.id) == [1, 2])
    api.on(.get, "/api/albums", AlbumPage(albums: albums(3...3), total: 3, version: "v1"))
    await model.loadMore()
    #expect(!model.moreFailed)
    #expect(model.albums?.map(\.id) == [1, 2, 3])
  }

  @Test func takesAnOlderServersWholeListAsOnePage() async {
    let api = FakeAPI()
    api.on(.get, "/api/albums", albums(1...5))
    let model = AlbumsModel(session: demoSession(api: api), sort: .title)
    await model.load()
    #expect(model.albums?.map(\.id) == [1, 2, 3, 4, 5])
    #expect(model.total == 5)
    #expect(!model.hasMore)
  }
}
