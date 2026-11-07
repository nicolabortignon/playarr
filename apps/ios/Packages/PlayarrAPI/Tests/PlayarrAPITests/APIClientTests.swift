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

    // A server behind a public address, reached from home through a router without NAT loopback. The home address is
    // tried only on Wi-Fi or a wired network, and only once the server there has proven it holds the session.

    static let info = json(#"{"id":"u-1","name":"Home","version":"0.7.0","minAppVersion":"1.0.0","setup":false}"#)

    /// A client for `token` on a server at `https://<away>`, with `http://<home>:4000` as its home address.
    func client(away: String, home: String, token: String? = "tok", network: LocalNetwork = LocalNetwork(isLocal: true), session: URLSession) -> APIClient {
        let address = HomeAddress(url: URL(string: "http://\(home):4000")!, token: "tok", session: session, network: network)
        return APIClient(baseURL: URL(string: "https://\(away)")!, home: address, token: token, session: session)
    }

    @Test func triesTheHomeAddressWhenThePublicOneCantBeReached() async throws {
        let away = uniqueHost(), home = uniqueHost()
        let publicTries = Mutex(0)
        let seen = Seen()
        let session = StubProtocol.session(host: away) { _ in
            publicTries.withLock { $0 += 1 }
            throw URLError(.cannotConnectToHost)
        }
        // The real server: it holds the session, and answers the proof.
        _ = StubProtocol.session(host: home) { request in
            seen.add(request)
            return proofAnswer(request, holding: ["tok"]) ?? (200, Self.info)
        }
        let client = client(away: away, home: home, session: session)

        #expect(try await client.send(API.Server.info()).name == "Home")
        #expect(seen.paths == ["/api/auth/proof", "/api/server"])
        let request = try #require(seen.all.last)
        #expect(request.url?.absoluteString == "http://\(home):4000/api/server")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")

        // The home address answered: the next request starts there, without asking again.
        _ = try await client.send(API.Server.info())
        #expect(publicTries.withLock { $0 } == 1)
        #expect(seen.paths == ["/api/auth/proof", "/api/server", "/api/server"])
    }

    @Test(arguments: ["answers anything", "answers the proof wrong", "plays back a proof", "knows no proof"])
    func neverSendsTheTokenToAHomeAddressThatCantProveIt(_ impostor: String) async throws {
        // A café's network, where something else answers at the server's home address: it would take any request.
        let away = uniqueHost(), home = uniqueHost()
        let seen = Seen()
        let session = StubProtocol.session(host: away) { _ in throw URLError(.cannotConnectToHost) }
        _ = StubProtocol.session(host: home) { request in
            seen.add(request)
            guard request.url?.path() == "/api/auth/proof" else { return (200, Self.info) }
            switch impostor {
            case "answers anything":
                return (200, Self.info)
            case "answers the proof wrong":
                return (200, json(#"{"proof":"\#(HomeAddress.base64URL(Data(repeating: 1, count: 32)))"}"#))
            case "plays back a proof":
                // The real server's answer to an earlier question, overheard: it doesn't answer this one.
                let earlier = "Zm9yLXRoZS10ZXN0LXZlY3Rvci1vbmx5LTAwMDAwMDA"
                let id = HomeAddress.id(nonce: earlier, key: HomeAddress.key(token: "tok"))
                return proofAnswer(URLRequest(url: URL(string: "http://\(home)/api/auth/proof?id=\(id)&nonce=\(earlier)")!), holding: ["tok"])!
            default:
                return (404, json(#"{"error":"Not found"}"#))
            }
        }
        let client = client(away: away, home: home, session: session)

        await #expect(throws: APIError.offline) { try await client.send(API.Auth.me()) }
        await #expect(throws: APIError.offline) { try await client.send(API.Server.info()) }

        // It was asked to prove itself, once, and never sent the token, nor anything but the question.
        #expect(seen.paths == ["/api/auth/proof"])
        #expect(seen.withToken.isEmpty)
    }

    @Test func keepsToThePublicAddressWithAServerFromBeforeTheProof() async throws {
        // The real server at home, but one too old to answer the proof (its auth hook turns the question away): unproven.
        let away = uniqueHost(), home = uniqueHost()
        let seen = Seen()
        let session = StubProtocol.session(host: away) { _ in throw URLError(.timedOut) }
        _ = StubProtocol.session(host: home) { request in
            seen.add(request)
            return request.url?.path() == "/api/auth/proof" ? (401, json(#"{"error":"Sign in to Playarr","setup":false}"#)) : (200, Self.info)
        }
        let client = client(away: away, home: home, session: session)

        await #expect(throws: APIError.offline) { try await client.send(API.Server.info()) }
        #expect(seen.paths == ["/api/auth/proof"])
    }

    @Test func triesTheHomeAddressOnlyOnWiFiOrWired() async throws {
        let away = uniqueHost(), home = uniqueHost()
        let seen = Seen()
        let session = StubProtocol.session(host: away) { _ in throw URLError(.cannotConnectToHost) }
        _ = StubProtocol.session(host: home) { request in
            seen.add(request)
            return proofAnswer(request, holding: ["tok"]) ?? (200, Self.info)
        }
        // Mobile data, where a private address could be anyone's.
        let client = client(away: away, home: home, network: LocalNetwork(isLocal: false), session: session)

        await #expect(throws: APIError.offline) { try await client.send(API.Server.info()) }
        #expect(seen.all.isEmpty)
    }

    @Test(arguments: [URLError.Code.serverCertificateUntrusted, .serverCertificateHasUnknownRoot, .serverCertificateHasBadDate, .secureConnectionFailed])
    func triesTheHomeAddressPastACertificateThatIsntTheServers(_ code: URLError.Code) async throws {
        // At home, a router without NAT loopback answering the public address with its own page and certificate: the
        // home address, once the server there has proven itself.
        let away = uniqueHost(), home = uniqueHost()
        let seen = Seen()
        let session = StubProtocol.session(host: away) { _ in throw URLError(code) }
        _ = StubProtocol.session(host: home) { request in
            seen.add(request)
            return proofAnswer(request, holding: ["tok"]) ?? (200, Self.info)
        }
        let client = client(away: away, home: home, session: session)

        _ = try await client.send(API.Server.info())
        #expect(seen.paths == ["/api/auth/proof", "/api/server"])
        #expect(seen.withToken.compactMap { $0.url?.path() } == ["/api/server"])
    }

    @Test func neverSendsTheTokenPastACaptivePortal() async throws {
        // A café's portal, answering the public address with its own certificate and its home address with its page.
        let away = uniqueHost(), home = uniqueHost()
        let seen = Seen()
        let session = StubProtocol.session(host: away) { _ in throw URLError(.serverCertificateUntrusted) }
        _ = StubProtocol.session(host: home) { request in
            seen.add(request)
            return (200, json(#"<html>Accept the terms</html>"#))
        }
        let client = client(away: away, home: home, session: session)

        await #expect(throws: APIError.offline) { try await client.send(API.Auth.me()) }
        #expect(seen.paths == ["/api/auth/proof"])
        #expect(seen.withToken.isEmpty)
    }

    @Test func provesTheHomeAddressAgainOnEveryNetwork() async throws {
        let away = uniqueHost(), home = uniqueHost()
        let seen = Seen()
        let session = StubProtocol.session(host: away) { _ in throw URLError(.cannotConnectToHost) }
        _ = StubProtocol.session(host: home) { request in
            seen.add(request)
            return proofAnswer(request, holding: ["tok"]) ?? (200, Self.info)
        }
        let network = LocalNetwork(isLocal: true)
        let client = client(away: away, home: home, network: network, session: session)
        _ = try await client.send(API.Server.info())

        // Off home and back: the public address first again, then the question again before the token goes.
        network.change(isLocal: true)
        _ = try await client.send(API.Server.info())
        #expect(seen.paths == ["/api/auth/proof", "/api/server", "/api/auth/proof", "/api/server"])

        // Mobile data: nothing more goes to the home address.
        network.change(isLocal: false)
        await #expect(throws: APIError.offline) { try await client.send(API.Server.info()) }
        #expect(seen.all.count == 4)
    }

    @Test func goesBackToThePublicAddressWhenTheHomeOneStopsAnswering() async throws {
        let away = uniqueHost(), home = uniqueHost()
        let atHome = Mutex(true)
        let session = StubProtocol.session(host: away) { _ in
            if atHome.withLock({ $0 }) { throw URLError(.timedOut) }
            return (200, Self.info)
        }
        _ = StubProtocol.session(host: home) { request in
            if atHome.withLock({ $0 }) { return proofAnswer(request, holding: ["tok"]) ?? (200, Self.info) }
            throw URLError(.cannotConnectToHost)
        }
        // Signing in nobody (GET /api/server): the home address still has to prove itself to an account first.
        let client = client(away: away, home: home, token: nil, session: session)
        _ = try await client.send(API.Server.info())

        atHome.withLock { $0 = false }

        #expect(try await client.send(API.Server.info()).name == "Home")
    }

    @Test func triesTheHomeAddressOnlyForConnectionFailures() async throws {
        let away = uniqueHost(), home = uniqueHost()
        let seen = Seen()
        let session = StubProtocol.session(host: away) { _ in (500, json(#"{"error":"Library not loaded"}"#)) }
        _ = StubProtocol.session(host: home) { request in
            seen.add(request)
            return (200, Data())
        }
        let client = client(away: away, home: home, session: session)

        await #expect(throws: APIError.server(status: 500, message: "Library not loaded")) { try await client.send(API.Server.info()) }
        #expect(seen.all.isEmpty)
    }

    @Test func isOfflineWhenNeitherAddressAnswers() async throws {
        let away = uniqueHost(), home = uniqueHost()
        let session = StubProtocol.session(host: away) { _ in throw URLError(.cannotFindHost) }
        _ = StubProtocol.session(host: home) { _ in throw URLError(.timedOut) }
        let client = client(away: away, home: home, session: session)

        await #expect(throws: APIError.offline) { try await client.send(API.Server.info()) }
    }
}
