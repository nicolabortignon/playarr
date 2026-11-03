import Foundation

/// Talks to one server as one account, or as nobody (to sign in). Every request carries
/// `X-Playarr: 1` and, with a token, `Authorization: Bearer <token>`; error answers become `APIError`.
public actor APIClient {
    public nonisolated let baseURL: URL
    private nonisolated let token: String?
    private let session: URLSession
    private nonisolated let timeout: TimeInterval
    private let onUnauthorized: @Sendable () async -> Void

    /// `onUnauthorized` runs when the server answers 401 to a request that carried the token: the
    /// session has ended (ServerStore marks the account signed out).
    public init(
        baseURL: URL,
        token: String? = nil,
        session: URLSession = .shared,
        timeout: TimeInterval = 30,
        onUnauthorized: @escaping @Sendable () async -> Void = {}
    ) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        self.timeout = timeout
        self.onUnauthorized = onUnauthorized
    }

    public func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T {
        let request = try urlRequest(for: endpoint)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw Self.transportError(error)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.offline }
        if http.statusCode == 401, token != nil {
            await onUnauthorized()
            throw APIError.unauthorized
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.server(status: http.statusCode, message: Self.message(in: data, status: http.statusCode))
        }
        do {
            return try Self.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    /// The request `send` makes for `endpoint`.
    public nonisolated func urlRequest<T>(for endpoint: Endpoint<T>) throws -> URLRequest {
        var request = URLRequest(url: try Self.url(base: baseURL, path: endpoint.path, query: endpoint.query))
        request.httpMethod = endpoint.method.rawValue
        request.timeoutInterval = endpoint.timeout ?? timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // The server's guard against other sites; Bearer requests are exempt, but it costs nothing.
        request.setValue("1", forHTTPHeaderField: "X-Playarr")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body = try endpoint.bodyData() {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    /// Decodes an answer as `send` does: an empty body (204) reads as JSON null, which `NoContent` accepts.
    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try JSONDecoder().decode(type, from: data.isEmpty ? Data("null".utf8) : data)
    }

    static func url(base: URL, path: String, query: [URLQueryItem]) throws -> URL {
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { throw URLError(.badURL) }
        var prefix = components.percentEncodedPath
        if prefix.hasSuffix("/") { prefix.removeLast() }
        components.percentEncodedPath = prefix + path
        components.percentEncodedQuery = query.isEmpty ? nil : query.map { item in
            let value = item.value.map { "=" + ($0.addingPercentEncoding(withAllowedCharacters: .uriComponent) ?? $0) } ?? ""
            return Endpoint<NoContent>.segment(item.name) + value
        }.joined(separator: "&")
        guard let url = components.url else { throw URLError(.badURL) }
        return url
    }

    static func transportError(_ error: any Error) -> any Error {
        if error is CancellationError { return error }
        if let urlError = error as? URLError, urlError.code == .cancelled { return CancellationError() }
        return APIError.offline
    }

    private struct ErrorBody: Decodable {
        let error: String?
    }

    static func message(in data: Data, status: Int) -> String {
        (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "Request failed (\(status))"
    }
}
