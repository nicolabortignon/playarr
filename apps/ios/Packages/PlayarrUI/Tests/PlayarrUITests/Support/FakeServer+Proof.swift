import CryptoKit
import Foundation

extension FakeServer {
  /// The server's answer to the home-address proof (`GET /api/auth/proof`) from a server holding the sessions of
  /// `tokens`, made as apps/server/src/accounts/sessions.ts makes it; nil for any other request.
  static func proof(_ request: URLRequest, holding tokens: [String]) -> (Int, String)? {
    guard let url = request.url, url.path() == "/api/auth/proof" else { return nil }
    guard request.value(forHTTPHeaderField: "X-Playarr") == "1" else { return (403, #"{"error":"Only the Playarr app asks this"}"#) }
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
    return (200, #"{"proof":"\#(mac(key, "playarr-home-proof:" + nonce))"}"#)
  }
}
