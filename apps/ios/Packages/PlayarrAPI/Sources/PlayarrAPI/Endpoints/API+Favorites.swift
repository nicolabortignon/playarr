extension API {
    public enum Favorites {
        public static func list() -> Endpoint<[FavoriteTrack]> { Endpoint(.get, "/api/favorites") }

        /// `favoritedAt`: when a song taken back (Undo, or hearted again) was first favorited, so it goes back where it
        /// was in the list rather than to the top; nil for a song favorited now.
        public static func add(recordingId: String, favoritedAt: String? = nil) -> Endpoint<NoContent> {
            Endpoint(.put, "/api/favorites/\(Endpoint<NoContent>.segment(recordingId))", body: favoritedAt.map { ["favoritedAt": $0] })
        }

        public static func remove(recordingId: String) -> Endpoint<NoContent> {
            Endpoint(.delete, "/api/favorites/\(Endpoint<NoContent>.segment(recordingId))")
        }

        /// "Songs like these" under Favorites, as `Playlists.recommendations` under a playlist.
        public static func recommendations(variant: Int = 0) -> Endpoint<Recommendations> {
            Endpoint(.get, "/api/favorites/recommendations", query: [.init(name: "variant", value: String(variant))])
        }
    }
}
