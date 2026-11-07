extension API {
    /// Browsing the library.
    public enum Library {
        public static func artists() -> Endpoint<[Artist]> { Endpoint(.get, "/api/artists") }
        public static func artist(id: Int) -> Endpoint<ArtistDetail> { Endpoint(.get, "/api/artists/\(id)") }
        public static func artistTracks(id: Int) -> Endpoint<[Track]> { Endpoint(.get, "/api/artists/\(id)/tracks") }

        public static func albums(sort: AlbumSort, limit: Int? = nil) -> Endpoint<[Album]> {
            Endpoint(.get, "/api/albums", query: Endpoint<[Album]>.items(["sort": sort.rawValue, "limit": limit.map(String.init)]))
        }

        /// `limit` albums in `sort`'s order from `offset` (0 first): a page, or all of them from an older server.
        public static func albumPage(sort: AlbumSort, offset: Int, limit: Int) -> Endpoint<AlbumsAnswer> {
            Endpoint(
                .get, "/api/albums",
                query: [.init(name: "sort", value: sort.rawValue), .init(name: "offset", value: String(offset)), .init(name: "limit", value: String(limit))])
        }

        public static func randomAlbums(limit: Int = 12) -> Endpoint<[Album]> {
            Endpoint(.get, "/api/albums/random", query: [.init(name: "limit", value: String(limit))])
        }

        public static func album(id: Int) -> Endpoint<AlbumDetail> { Endpoint(.get, "/api/albums/\(id)") }

        public static func randomTracks(limit: Int = 50) -> Endpoint<[Track]> {
            Endpoint(.get, "/api/tracks/random", query: [.init(name: "limit", value: String(limit))])
        }

        /// Jump back in: albums heard lately.
        public static func recentAlbums() -> Endpoint<[Album]> { Endpoint(.get, "/api/plays/recent-albums") }

        /// Show metadata.
        public static func trackMetadata(id: Int) -> Endpoint<TrackMetadata> { Endpoint(.get, "/api/tracks/\(id)/metadata") }

        /// Show metadata → Match again (admin).
        public static func rematchFile(fileId: Int) -> Endpoint<RematchResult> { Endpoint(.post, "/api/files/\(fileId)/rematch") }

        public static func lyrics(trackId: Int) -> Endpoint<LyricsAnswer> { Endpoint(.get, "/api/tracks/\(trackId)/lyrics") }
    }
}
