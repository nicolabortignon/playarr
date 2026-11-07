import CryptoKit
import Foundation
import Synchronization

/// The server's side of the home-address proof, written again from the server's code (apps/server/src/routes/auth.ts and
/// accounts/sessions.ts `proof`) rather than from `HomeAddress`: the answer to `GET /api/auth/proof` from a server holding
/// the sessions of `tokens`, or nil for any other request. An id that's none of theirs gets an answer from a random key,
/// as there, and a question without Playarr's header a 403.
func proofAnswer(_ request: URLRequest, holding tokens: [String]) -> (status: Int, body: Data)? {
    guard let url = request.url, url.path() == "/api/auth/proof" else { return nil }
    guard request.value(forHTTPHeaderField: "X-Playarr") == "1" else { return (403, json(#"{"error":"Only the Playarr app asks this"}"#)) }
    guard let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
          let id = query.first(where: { $0.name == "id" })?.value,
          let nonce = query.first(where: { $0.name == "nonce" })?.value
    else { return nil }
    func mac(_ key: SymmetricKey, _ message: String) -> String {
        Data(HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: key)).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    let held = tokens.map { SymmetricKey(data: SHA256.hash(data: Data($0.utf8))) }
    let key = held.first { mac($0, "playarr-home-id:" + nonce) == id } ?? SymmetricKey(size: .bits256)
    return (200, json(#"{"proof":"\#(mac(key, "playarr-home-proof:" + nonce))"}"#))
}

/// Every request a host was sent, to look through afterwards.
final class Seen: Sendable {
    private let requests = Mutex<[URLRequest]>([])

    func add(_ request: URLRequest) { requests.withLock { $0.append(request) } }
    var all: [URLRequest] { requests.withLock { $0 } }
    var paths: [String] { all.compactMap { $0.url?.path() } }
    /// The requests that carried a token.
    var withToken: [URLRequest] { all.filter { $0.value(forHTTPHeaderField: "Authorization") != nil } }
}
