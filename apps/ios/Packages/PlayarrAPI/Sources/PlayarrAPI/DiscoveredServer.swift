import Foundation

/// A Playarr server found on the home network by Bonjour (`_playarr._tcp`).
public struct DiscoveredServer: Hashable, Sendable, Identifiable {
    /// The server's UUID (TXT `id`), the same as GET /api/server's.
    public var id: String
    public var name: String
    public var version: String
    public var baseURL: URL

    public init(id: String, name: String, version: String, baseURL: URL) {
        self.id = id
        self.name = name
        self.version = version
        self.baseURL = baseURL
    }

    /// From the service's TXT record (`id`, `v`, `name`, `path`) and resolved address; nil without an id.
    public init?(txt: [String: String], host: String, port: Int) {
        guard let id = txt["id"], !id.isEmpty else { return nil }
        let bracketed = host.contains(":") ? "[\(host.replacingOccurrences(of: "%", with: "%25"))]" : host
        var path = txt["path"] ?? "/"
        while path.hasSuffix("/") { path.removeLast() }
        guard let url = URL(string: "http://\(bracketed):\(port)\(path)") else { return nil }
        self.init(id: id, name: txt["name"].flatMap { $0.isEmpty ? nil : $0 } ?? "Playarr", version: txt["v"] ?? "", baseURL: url)
    }

    /// `servers` with `server` added, one entry per server id (the newest address wins), sorted by name.
    public static func merge(_ servers: [DiscoveredServer], _ server: DiscoveredServer) -> [DiscoveredServer] {
        (servers.filter { $0.id != server.id } + [server]).sorted {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }
}
