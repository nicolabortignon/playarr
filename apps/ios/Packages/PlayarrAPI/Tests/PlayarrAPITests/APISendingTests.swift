import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct APISendingTests {
  @Test func theClientSendsThroughTheProtocol() async throws {
    let host = "sending-\(UUID().uuidString.lowercased()).invalid"
    let session = StubProtocol.session(host: host) { request in
      #expect(request.url?.path() == "/api/artists")
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
      return (200, Data(#"[{"id":7,"name":"Massive Attack","sortName":"Massive Attack","genres":[],"albumCount":1,"trackCount":2}]"#.utf8))
    }
    let sender: any APISending = APIClient(baseURL: URL(string: "http://\(host)")!, token: "tok", session: session)
    #expect(try await sender.send(API.Library.artists()).map(\.name) == ["Massive Attack"])
  }
}
