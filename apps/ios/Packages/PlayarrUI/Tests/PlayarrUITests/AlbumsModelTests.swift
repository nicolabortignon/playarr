import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct AlbumsModelTests {
  @Test func asksForTheSortChosen() async {
    let api = FakeAPI.demoLibrary()
    let model = AlbumsModel(session: demoSession(api: api), sort: .artist)
    await model.albums.load()
    model.sort = .added
    await model.albums.load()
    #expect(model.albums.key == .albums(.added))
    #expect(model.albums.value?.count == 3)
    #expect(api.calls(.get, "/api/albums").count == 2)
  }
}
