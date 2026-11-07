import CryptoKit
import Foundation
import Synchronization
import Testing
@testable import PlayarrAPI

@Suite struct HomeAddressTests {
    let home = uniqueHost()
    let network = LocalNetwork(isLocal: true)

    func address(token: String = "tok", on network: LocalNetwork? = nil, _ handler: @escaping StubProtocol.Handler) -> HomeAddress {
        HomeAddress(url: URL(string: "http://\(home):4000")!, token: token, session: StubProtocol.session(host: home, handler: handler), network: network ?? self.network)
    }

    /// Worked out on the server's side by hand (apps/server/src/routes/auth.test.ts `VECTOR`): the same four there.
    @Test func matchesTheServersWorkedExample() {
        let token = "q2vK8uWm0sZb4N3yRj7tLx5pAe1cDh9fGo6iUk2wQzE"
        let nonce = "Zm9yLXRoZS10ZXN0LXZlY3Rvci1vbmx5LTAwMDAwMDA"
        let key = HomeAddress.key(token: token)
        #expect(HomeAddress.id(nonce: nonce, key: key) == "zMeUpoDAZIEdQYfetB3cfbWaBgpXvauknrcPSpZz80w")
        #expect(HomeAddress.proves("-HSL_2JeFGzqbuQ_mS3Woz6K3OzGVWUUm8WPkiUP1p4", nonce: nonce, key: key))
        // For another nonce, or another session, the same answer proves nothing.
        #expect(!HomeAddress.proves("-HSL_2JeFGzqbuQ_mS3Woz6K3OzGVWUUm8WPkiUP1p4", nonce: nonce + "x", key: key))
        #expect(!HomeAddress.proves("-HSL_2JeFGzqbuQ_mS3Woz6K3OzGVWUUm8WPkiUP1p4", nonce: nonce, key: HomeAddress.key(token: "another")))
    }

    @Test func asksWithoutTheTokenOrAnythingToAnswerFrom() async throws {
        let token = "q2vK8uWm0sZb4N3yRj7tLx5pAe1cDh9fGo6iUk2wQzE"
        let seen = Seen()
        let home = address(token: token) { request in
            seen.add(request)
            return proofAnswer(request, holding: [token]) ?? (404, Data())
        }
        #expect(await home.verify())
        network.change(isLocal: true)
        #expect(await home.verify())

        let asked = seen.all
        #expect(asked.count == 2)
        let hash = Data(SHA256.hash(data: Data(token.utf8)))
        for request in asked {
            #expect(request.httpMethod == "GET")
            #expect(request.url?.path() == "/api/auth/proof")
            #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
            #expect(request.value(forHTTPHeaderField: "X-Playarr") == "1")
            // Neither the token nor its hash (the key the answer is made with), in any spelling, anywhere it went.
            let sent = (request.url?.absoluteString ?? "") + "\(request.allHTTPHeaderFields ?? [:])"
            for secret in [token, hash.map { String(format: "%02x", $0) }.joined(), hash.base64EncodedString(), HomeAddress.base64URL(hash)] {
                #expect(!sent.contains(secret))
            }
        }
        // A fresh nonce, and so a fresh id, every time: an id overheard on one network says nothing on the next.
        let queries = asked.compactMap { $0.url?.query() }
        #expect(Set(queries).count == 2)
    }

    @Test func isProvenOnceTheServerAnswers() async {
        let home = address { proofAnswer($0, holding: ["tok"]) ?? (404, Data()) }
        #expect(!home.isProven)
        #expect(await home.verify())
        #expect(home.isProven)
    }

    @Test(arguments: [
        "a wrong answer", "an answer for another nonce", "an older server, set up", "an older server, in setup mode", "not Playarr",
    ])
    func isntProvenByAnythingElse(_ impostor: String) async {
        let home = address { request in
            switch impostor {
            case "a wrong answer":
                return (200, json(#"{"proof":"\#(HomeAddress.base64URL(Data(repeating: 7, count: 32)))"}"#))
            case "an answer for another nonce":
                // The server's real answer to an earlier question, overheard and played back.
                let earlier = "Zm9yLXRoZS10ZXN0LXZlY3Rvci1vbmx5LTAwMDAwMDA"
                let id = HomeAddress.id(nonce: earlier, key: HomeAddress.key(token: "tok"))
                return proofAnswer(URLRequest(url: URL(string: "http://\(self.home)/api/auth/proof?id=\(id)&nonce=\(earlier)")!), holding: ["tok"])!
            case "an older server, set up": return (401, json(#"{"error":"Sign in to Playarr","setup":false}"#))
            case "an older server, in setup mode": return (404, json(#"{"error":"Not found"}"#))
            default: return (200, Data("<html>Welcome to the router</html>".utf8))
            }
        }
        #expect(await !home.verify())
        #expect(!home.isProven)
    }

    @Test func asksOncePerNetwork() async {
        let asked = Mutex(0)
        let home = address { request in
            asked.withLock { $0 += 1 }
            return proofAnswer(request, holding: ["tok"]) ?? (404, Data())
        }
        // Everyone asking at once shares the one answer, and later ones go by it.
        async let a = home.verify()
        async let b = home.verify()
        async let c = home.verify()
        #expect(await [a, b, c] == [true, true, true])
        #expect(await home.verify())
        #expect(asked.withLock { $0 } == 1)

        // Another network: the proof doesn't come with the phone.
        network.change(isLocal: true)
        #expect(!home.isProven)
        #expect(await home.verify())
        #expect(asked.withLock { $0 } == 2)
    }

    @Test func neverAsksOffWiFiOrWired() async {
        let asked = Mutex(0)
        let home = address(on: LocalNetwork(isLocal: false)) { request in
            asked.withLock { $0 += 1 }
            return proofAnswer(request, holding: ["tok"]) ?? (404, Data())
        }
        #expect(await !home.verify())
        #expect(asked.withLock { $0 } == 0)
    }

    @Test func leavesTheProofBehindWithTheNetwork() async {
        let home = address { proofAnswer($0, holding: ["tok"]) ?? (404, Data()) }
        #expect(await home.verify())
        // Mobile data.
        network.change(isLocal: false)
        #expect(!home.isProven)
        #expect(await !home.verify())
    }
}
