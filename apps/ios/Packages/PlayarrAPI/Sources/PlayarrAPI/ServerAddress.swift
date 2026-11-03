import Foundation

/// Turns what someone typed into a server's base URL. Plain HTTP is only for the home network
/// (as App Transport Security allows); everything else is HTTPS.
public enum ServerAddress {
    public enum Problem: Error, Equatable, Sendable, LocalizedError {
        case empty
        case invalid
        case needsHTTPS

        public var errorDescription: String? {
            switch self {
            case .empty: "Enter the server’s address."
            case .invalid: "That isn’t a web address."
            case .needsHTTPS: "Use https:// for a server outside your home network."
            }
        }
    }

    public static func url(from text: String) throws(Problem) -> URL {
        var text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw .empty }
        if !text.contains("://") {
            let host = text.split(separator: "/").first.map(String.init) ?? text
            text = (isLocal(host: hostOnly(host)) ? "http://" : "https://") + text
        }
        guard var components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty
        else { throw .invalid }
        if scheme == "http", !isLocal(host: host) { throw .needsHTTPS }
        components.scheme = scheme
        components.query = nil
        components.fragment = nil
        while components.path.hasSuffix("/") { components.path.removeLast() }
        guard let url = components.url else { throw .invalid }
        return url
    }

    /// localhost, single-label and .local names, and private, loopback and link-local addresses.
    public static func isLocal(host: String) -> Bool {
        let host = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".local") { return true }
        let octets = host.split(separator: ".").compactMap { UInt8($0) }
        if octets.count == 4 {
            switch (octets[0], octets[1]) {
            case (10, _), (127, _), (192, 168), (169, 254): return true
            case (172, let b): return (16...31).contains(b)
            default: return false
            }
        }
        if host.contains(":") { return host == "::1" || host.hasPrefix("fe80:") || host.hasPrefix("fc") || host.hasPrefix("fd") }
        return !host.contains(".")
    }

    private static func hostOnly(_ hostAndPort: String) -> String {
        if hostAndPort.hasPrefix("[") { return String(hostAndPort.prefix { $0 != "]" }.dropFirst()) }
        return String(hostAndPort.prefix { $0 != ":" })
    }
}
