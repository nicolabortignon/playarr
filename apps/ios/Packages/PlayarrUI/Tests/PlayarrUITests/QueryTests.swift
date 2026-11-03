import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct QueryTests {
  @Test func showsWhatIsCachedThenTheServersAnswer() async throws {
    let cache = QueryCache(directory: nil)
    cache.set(["old"], for: .artists)
    let query = Query(.artists, cache: cache, staleAfter: 0) { ["new"] }
    #expect(query.value == ["old"])
    await query.load()
    #expect(query.value == ["new"])
  }

  @Test func doesntAskAgainWhileFresh() async throws {
    let api = FakeAPI()
    api.on(.get, "/api/artists", [Demo.artist])
    let cache = QueryCache(directory: nil)
    let query = Query(.artists, cache: cache) { try await api.send(API.Library.artists()) }
    await query.load()
    await query.load()
    #expect(api.calls.count == 1)
  }

  @Test func keepsWhatIsShownWhenTheServerCantBeReached() async throws {
    let api = FakeAPI()
    api.fail(.get, "/api/artists", status: 503, "Server busy")
    let cache = QueryCache(directory: nil)
    cache.set([Demo.artist], for: .artists)
    let query = Query(.artists, cache: cache, staleAfter: 0) { try await api.send(API.Library.artists()) }
    await query.load()
    #expect(query.value == [Demo.artist])
    #expect(query.error == nil)
  }

  @Test func explainsAFailureWithNothingToShow() async throws {
    let api = FakeAPI()
    api.fail(.get, "/api/artists", status: 503, "Server busy")
    let query = Query(.artists, cache: QueryCache(directory: nil)) { try await api.send(API.Library.artists()) }
    await query.load()
    #expect(query.value == nil)
    #expect(query.error == "Server busy")
  }
}
