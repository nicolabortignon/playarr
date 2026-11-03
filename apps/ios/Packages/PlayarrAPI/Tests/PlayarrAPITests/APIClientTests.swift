import Foundation
import Synchronization
import Testing
@testable import PlayarrAPI

@Suite struct APIClientTests {
    @Test func sendsTheTokenAndThePlayarrHeader() async throws {
        let host = uniqueHost()
        let seen = Mutex<URLRequest?>(nil)
        let session = StubProtocol.session(host: host) { request in
            seen.withLock { $0 = request }
            return (200, json(#"{"id":"u-1","name":"Home","version":"0.7.0","minAppVersion":"1.0.0","setup":false}"#))
        }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, token: "tok", session: session)

        let info = try await client.send(API.Server.info())

        #expect(info.name == "Home")
        let request = try #require(seen.withLock { $0 })
        #expect(request.url?.absoluteString == "http://\(host)/api/server")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        #expect(request.value(forHTTPHeaderField: "X-Playarr") == "1")
        #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == nil)
    }

    @Test func sendsNoAuthorizationWithoutAToken() throws {
        let client = APIClient(baseURL: URL(string: "http://localhost:4000")!)
        let request = try client.urlRequest(for: API.Server.info())
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func sendsTheBodyAsJSON() async throws {
        let host = uniqueHost()
        let body = Mutex<Data?>(nil)
        let session = StubProtocol.session(host: host) { request in
            body.withLock { $0 = request.sentBody }
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
            #expect(request.httpMethod == "POST")
            return (200, json(#"{"queued":4400}"#))
        }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, token: "tok", session: session)

        _ = try await client.send(API.Analysis.run(.loudness, again: true))
        let sent = try JSONSerialization.jsonObject(with: try #require(body.withLock { $0 })) as? [String: Bool]
        #expect(sent == ["again": true])
    }

    @Test func keepsThePathOfTheServerAddress() throws {
        let client = APIClient(baseURL: URL(string: "https://example.com/playarr/")!)
        let request = try client.urlRequest(for: API.Library.albums(sort: .added, limit: 20))
        #expect(request.url?.absoluteString == "https://example.com/playarr/api/albums?sort=added&limit=20")
    }

    @Test func encodesQueriesAndSegmentsLikeTheWeb() throws {
        let client = APIClient(baseURL: URL(string: "http://localhost:4000")!)
        #expect(try client.urlRequest(for: API.Search.library("AC+DC & co")).url?.absoluteString == "http://localhost:4000/api/search?q=AC%2BDC%20%26%20co")
        #expect(try client.urlRequest(for: API.Favorites.add(recordingId: "track:12")).url?.absoluteString == "http://localhost:4000/api/favorites/track%3A12")
    }

    @Test func turnsAnErrorAnswerIntoItsMessage() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in (404, json(#"{"error":"Album not found"}"#)) }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, token: "tok", session: session)

        await #expect(throws: APIError.server(status: 404, message: "Album not found")) {
            try await client.send(API.Library.album(id: 9))
        }
    }

    @Test func saysWhichStatusWhenTheErrorHasNoMessage() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in (502, Data()) }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, session: session)

        await #expect(throws: APIError.server(status: 502, message: "Request failed (502)")) {
            try await client.send(API.Server.health())
        }
    }

    @Test func endsTheSessionOnA401WithAToken() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in (401, json(#"{"error":"Sign in","setup":false}"#)) }
        let ended = Mutex(0)
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, token: "old", session: session) {
            ended.withLock { $0 += 1 }
        }

        await #expect(throws: APIError.unauthorized) { try await client.send(API.Auth.me()) }
        #expect(ended.withLock { $0 } == 1)
    }

    @Test func keepsTheMessageOfA401WithoutAToken() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in (401, json(#"{"error":"Wrong username or password"}"#)) }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, session: session)

        await #expect(throws: APIError.server(status: 401, message: "Wrong username or password")) {
            try await client.send(API.Auth.signIn(username: "a", password: "b", device: DeviceInfo(name: "Test", platform: "ios")))
        }
    }

    @Test func acceptsNoContent() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in (204, Data()) }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, token: "tok", session: session)

        #expect(try await client.send(API.Auth.signOut()) == NoContent())
    }

    @Test func reportsAnAnswerItCantRead() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in (200, json(#"{"unexpected":true}"#)) }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, session: session)

        await #expect {
            try await client.send(API.Server.info())
        } throws: { error in
            if case APIError.decoding = error { true } else { false }
        }
    }

    @Test func isOfflineWhenTheServerCantBeReached() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in throw URLError(.cannotConnectToHost) }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, session: session)

        await #expect(throws: APIError.offline) { try await client.send(API.Server.info()) }
    }

    @Test func passesCancellationOn() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in throw URLError(.cancelled) }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, session: session)

        await #expect(throws: CancellationError.self) { try await client.send(API.Server.info()) }
    }

    @Test func usesTheEndpointsTimeout() throws {
        let client = APIClient(baseURL: URL(string: "http://localhost:4000")!, timeout: 30)
        #expect(try client.urlRequest(for: API.Server.info()).timeoutInterval == 10)
        #expect(try client.urlRequest(for: API.Server.health()).timeoutInterval == 30)
    }
}
