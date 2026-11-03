extension API {
    public enum Playlists {
        public static func list() -> Endpoint<[PlaylistSummary]> { Endpoint(.get, "/api/playlists") }
        public static func get(id: Int) -> Endpoint<PlaylistDetail> { Endpoint(.get, "/api/playlists/\(id)") }

        public static func create(name: String, description: String? = nil, recordingIds: [String]? = nil) -> Endpoint<PlaylistDetail> {
            Endpoint(.post, "/api/playlists", body: CreateBody(name: name, description: description, recordingIds: recordingIds))
        }

        public static func update(id: Int, name: String? = nil, description: String? = nil) -> Endpoint<PlaylistDetail> {
            Endpoint(.patch, "/api/playlists/\(id)", body: UpdateBody(name: name, description: description))
        }

        public static func delete(id: Int) -> Endpoint<NoContent> { Endpoint(.delete, "/api/playlists/\(id)") }

        public static func addItems(id: Int, recordingIds: [String]) -> Endpoint<PlaylistDetail> {
            Endpoint(.post, "/api/playlists/\(id)/items", body: ["recordingIds": recordingIds])
        }

        public static func removeItem(id: Int, itemId: Int) -> Endpoint<PlaylistDetail> {
            Endpoint(.delete, "/api/playlists/\(id)/items/\(itemId)")
        }

        public static func reorder(id: Int, itemIds: [Int]) -> Endpoint<PlaylistDetail> {
            Endpoint(.put, "/api/playlists/\(id)/order", body: ["itemIds": itemIds])
        }

        public static func setCover(id: Int, layout: CoverLayout, variant: Int) -> Endpoint<PlaylistDetail> {
            Endpoint(.put, "/api/playlists/\(id)/cover", body: CoverBody(layout: layout, variant: variant))
        }

        public static func recommendations(id: Int, variant: Int = 0) -> Endpoint<Recommendations> {
            Endpoint(.get, "/api/playlists/\(id)/recommendations", query: [.init(name: "variant", value: String(variant))])
        }

        private struct CreateBody: Encodable, Sendable {
            let name: String
            let description: String?
            let recordingIds: [String]?
        }

        private struct UpdateBody: Encodable, Sendable {
            let name: String?
            let description: String?
        }

        private struct CoverBody: Encodable, Sendable {
            let layout: CoverLayout
            let variant: Int
        }
    }
}
