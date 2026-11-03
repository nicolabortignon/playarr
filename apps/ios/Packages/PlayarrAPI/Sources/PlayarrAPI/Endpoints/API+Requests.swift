extension API {
    /// Album requests (Lidarr), when requests are on and the account may request.
    public enum Requests {
        public static func list() -> Endpoint<[AlbumRequest]> { Endpoint(.get, "/api/requests") }
        public static func request(_ album: AlbumRef) -> Endpoint<AlbumRequest> { Endpoint(.post, "/api/requests", body: album) }

        public static func remove(mbid: String) -> Endpoint<NoContent> {
            Endpoint(.delete, "/api/requests/\(Endpoint<NoContent>.segment(mbid))")
        }
    }
}
