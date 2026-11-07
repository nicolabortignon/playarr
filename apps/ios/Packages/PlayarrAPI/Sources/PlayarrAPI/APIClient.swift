import Foundation

/// Talks to one server as one account, or as nobody (to sign in). Every request carries
/// `X-Playarr: 1` and, with a token, `Authorization: Bearer <token>`; error answers become `APIError`.
public actor APIClient {
    public nonisolated let baseURL: URL
    /// The server's home-network address when `baseURL` is its public one, with what it has proved on this network.
    /// A request that can't connect to the public address is tried there once the server there has proven itself
    /// (`HomeAddress`), and goes there first afterwards while it stays proven; one that can't connect there goes back.
    public nonisolated let home: HomeAddress?
    public nonisolated var localURL: URL? { home?.url }
    private var homeFirst = false
    private nonisolated let token: String?
    private let session: URLSession
    private nonisolated let timeout: TimeInterval
    private let onUnauthorized: @Sendable () async -> Void

    /// `onUnauthorized` runs when the server answers 401 to a request that carried the token: the
    /// session has ended (ServerStore marks the account signed out).
    public init(
        baseURL: URL,
        home: HomeAddress? = nil,
        token: String? = nil,
        session: URLSession = .shared,
        timeout: TimeInterval = 30,
        onUnauthorized: @escaping @Sendable () async -> Void = {}
    ) {
        self.baseURL = baseURL
        self.home = home
        self.token = token
        self.session = session
        self.timeout = timeout
        self.onUnauthorized = onUnauthorized
    }

    public func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T {
        let data: Data
        let http: HTTPURLResponse
        do {
            (data, http) = try await load(endpoint)
        } catch {
            throw Self.transportError(error)
        }
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

    /// The answer from the public address, or from the home address where that's proven and answered last; when the
    /// one tried can't be reached, from the other, the home address only once it's proven on this network.
    private func load<T>(_ endpoint: Endpoint<T>) async throws -> (Data, HTTPURLResponse) {
        guard let home else { return try await load(endpoint, from: baseURL) }
        if homeFirst, home.isProven {
            do {
                return try await load(endpoint, from: home.url)
            } catch let error as URLError where Self.couldntConnect(error) {
                try Task.checkCancellation()
                homeFirst = false
                return try await load(endpoint, from: baseURL)
            }
        }
        do {
            return try await load(endpoint, from: baseURL)
        } catch let error as URLError where Self.couldntConnect(error) {
            try Task.checkCancellation()
            // Only on Wi-Fi or a wired network, and only to the server itself: whatever else answers at a home address
            // on another network (a café's, a captive portal's) never sees the token, or a question it could answer.
            guard await home.verify() else { throw error }
            let answer = try await load(endpoint, from: home.url)
            homeFirst = true
            return answer
        }
    }

    private func load<T>(_ endpoint: Endpoint<T>, from base: URL) async throws -> (Data, HTTPURLResponse) {
        // Nothing goes to the home address unless it's proven on the network the phone is on as it goes (it may have
        // just changed).
        if base == home?.url, home?.isProven != true { throw URLError(.cannotConnectToHost) }
        let (data, response) = try await session.data(for: urlRequest(for: endpoint, base: base))
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }

    /// Failures that say the server didn't answer at that address, as opposed to the server answering with an error:
    /// nothing answered, or something else did, with a certificate that isn't the server's (at home, a router without NAT
    /// loopback answering the public address with its own page; away, a captive portal). Either way the home address
    /// is worth a try, and it gets the token only once the server there has proven itself (`HomeAddress`), which a
    /// portal's network or anything else at that address can't.
    public static func couldntConnect(_ error: URLError) -> Bool {
        switch error.code {
        case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .timedOut, .networkConnectionLost, .notConnectedToInternet,
             .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid:
            true
        default:
            false
        }
    }

    /// The request `send` makes for `endpoint` (at `baseURL`).
    public nonisolated func urlRequest<T>(for endpoint: Endpoint<T>) throws -> URLRequest {
        try urlRequest(for: endpoint, base: baseURL)
    }

    private nonisolated func urlRequest<T>(for endpoint: Endpoint<T>, base: URL) throws -> URLRequest {
        var request = URLRequest(url: try Self.url(base: base, path: endpoint.path, query: endpoint.query))
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
