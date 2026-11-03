import Foundation

public enum HTTPMethod: String, Sendable {
    case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE"
}

/// One call to the server: method, path, query and JSON body, typed by its answer.
public struct Endpoint<Response: Decodable & Sendable>: Sendable {
    public var method: HTTPMethod
    /// From the server's root, percent-encoded: "/api/albums/12".
    public var path: String
    public var query: [URLQueryItem]
    /// Sent as JSON.
    public var body: (any Encodable & Sendable)?
    /// Seconds before giving up; nil uses the client's default.
    public var timeout: TimeInterval?

    public init(
        _ method: HTTPMethod = .get,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (any Encodable & Sendable)? = nil,
        timeout: TimeInterval? = nil
    ) {
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        self.timeout = timeout
    }

    /// The body as JSON, or nil without one.
    public func bodyData() throws -> Data? {
        guard let body else { return nil }
        return try JSONEncoder().encode(body)
    }
}

extension Endpoint {
    /// A path segment encoded like the web's encodeURIComponent ("track:12" → "track%3A12").
    static func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .uriComponent) ?? value
    }

    /// Query items, leaving out the nil ones.
    static func items(_ pairs: KeyValuePairs<String, String?>) -> [URLQueryItem] {
        pairs.compactMap { name, value in value.map { URLQueryItem(name: name, value: $0) } }
    }
}

extension CharacterSet {
    /// What encodeURIComponent leaves as is.
    static let uriComponent = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
}
