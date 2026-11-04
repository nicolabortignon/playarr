import Foundation

/// The dev server, for UI tests that sign in and clean up after themselves through its API.
struct DevServer: Sendable {
  let url: URL

  private struct SignIn: Encodable {
    let username, password: String
    let device = "UI tests"
    let platform = "ios"
  }

  private struct Token: Decodable { let token: String }
  private struct Listed: Decodable { let id: Int; let username: String }

  /// Signs in and answers the session's token.
  func signIn(username: String, password: String) async throws -> String {
    let data = try await send("POST", "/api/auth/sign-in", body: try JSONEncoder().encode(SignIn(username: username, password: password)))
    return try JSONDecoder().decode(Token.self, from: data).token
  }

  /// Removes the account with this username, if there is one.
  func removeAccount(_ username: String, token: String) async throws {
    let accounts = try JSONDecoder().decode([Listed].self, from: try await send("GET", "/api/accounts", token: token))
    guard let account = accounts.first(where: { $0.username == username }) else { return }
    _ = try await send("DELETE", "/api/accounts/\(account.id)", token: token)
  }

  func signOut(token: String) async throws {
    _ = try await send("POST", "/api/auth/sign-out", token: token)
  }

  private func send(_ method: String, _ path: String, token: String? = nil, body: Data? = nil) async throws -> Data {
    var request = URLRequest(url: url.appending(path: path))
    request.httpMethod = method
    request.setValue("1", forHTTPHeaderField: "X-Playarr")
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      throw URLError(.badServerResponse, userInfo: [NSLocalizedDescriptionKey: "\(method) \(path) answered \(status): \(String(decoding: data, as: UTF8.self))"])
    }
    return data
  }
}
