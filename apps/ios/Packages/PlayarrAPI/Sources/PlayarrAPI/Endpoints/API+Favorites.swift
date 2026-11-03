extension API {
    public enum Favorites {
        public static func list() -> Endpoint<[FavoriteTrack]> { Endpoint(.get, "/api/favorites") }

        public static func add(recordingId: String) -> Endpoint<NoContent> {
            Endpoint(.put, "/api/favorites/\(Endpoint<NoContent>.segment(recordingId))")
        }

        public static func remove(recordingId: String) -> Endpoint<NoContent> {
            Endpoint(.delete, "/api/favorites/\(Endpoint<NoContent>.segment(recordingId))")
        }
    }
}
