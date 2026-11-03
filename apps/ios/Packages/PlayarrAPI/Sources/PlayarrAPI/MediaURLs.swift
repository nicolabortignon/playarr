import Foundation

/// Addresses of a server's songs, transitions and images. The token never goes in a URL: load them
/// with `request(for:)`, which puts it in the Authorization header (and only for this server).
public struct MediaURLs: Sendable {
    public let baseURL: URL
    /// The server's home-network address when `baseURL` is its public one (see `ServerRecord.localURL`).
    public let localURL: URL?
    private let token: String?

    public init(baseURL: URL, localURL: URL? = nil, token: String?) {
        self.baseURL = baseURL
        self.localURL = localURL
        self.token = token
    }

    /// A path the server gave (`Track.streamUrl`, `coverUrl`, a transition's `url`) on this server.
    /// Absolute URLs are returned as they are.
    public func url(_ path: String) -> URL? {
        if path.hasPrefix("http://") || path.hasPrefix("https://") { return URL(string: path) }
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        let parts = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        var prefix = components.percentEncodedPath
        if prefix.hasSuffix("/") { prefix.removeLast() }
        components.percentEncodedPath = prefix + String(parts[0])
        components.percentEncodedQuery = parts.count > 1 ? String(parts[1]) : nil
        return components.url
    }

    /// GET /stream/:fileId: the song's own file, with Range support.
    public func stream(fileId: Int) -> URL? { url("/stream/\(fileId)") }

    /// The song's file at a gain (dB), as a WAV levelled on the server: for a seek past what's downloaded.
    public func levelled(_ track: Track, gain: Double) -> URL? { url("\(track.streamUrl)/levelled.wav?gain=\(gain)") }

    /// A rendered transition: the `url` of a ready `TransitionAnswer` (or its `continuationUrl`).
    public func transition(_ path: String) -> URL? { url(path) }

    /// A cover or artist image resized by the server to `size` pixels (the longest side).
    public func art(_ path: String?, size: Int) -> URL? {
        guard let path, let base = url(path), var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "size", value: String(size))]
        return components.url
    }

    /// A candidate playlist cover for the cover picker.
    public func playlistCoverPreview(playlistId: Int, layout: CoverLayout, variant: Int, size: Int) -> URL? {
        art("/art/playlist/\(playlistId)/preview?layout=\(layout.rawValue)&variant=\(variant)", size: size)
    }

    /// `url` (one of these addresses) at the server's local address, to try when the public one can't be
    /// reached; nil without a local address or for a URL elsewhere.
    public func onLocalAddress(_ url: URL) -> URL? {
        guard let localURL, Self.sameOrigin(url, baseURL),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let local = URLComponents(url: localURL, resolvingAgainstBaseURL: false)
        else { return nil }
        var basePath = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? ""
        if basePath.hasSuffix("/") { basePath.removeLast() }
        guard components.percentEncodedPath.hasPrefix(basePath) else { return nil }
        var localPath = local.percentEncodedPath
        if localPath.hasSuffix("/") { localPath.removeLast() }
        components.scheme = local.scheme
        components.host = local.host
        components.port = local.port
        components.percentEncodedPath = localPath + components.percentEncodedPath.dropFirst(basePath.count)
        return components.url
    }

    /// A request for `url` carrying the token, when `url` is on this server (either address).
    public func request(for url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        if let token, isOnServer(url) { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func isOnServer(_ url: URL) -> Bool {
        Self.sameOrigin(url, baseURL) || localURL.map { Self.sameOrigin(url, $0) } == true
    }

    private static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        a.scheme == b.scheme && a.host() == b.host() && a.port == b.port
    }
}
