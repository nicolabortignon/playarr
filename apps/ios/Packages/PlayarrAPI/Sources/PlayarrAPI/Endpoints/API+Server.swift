extension API {
    /// The server itself: who it is, whether it's healthy, background work.
    public enum Server {
        /// GET /api/server: id, name, version, minAppVersion, setup mode. Answered without signing in.
        public static func info() -> Endpoint<ServerInfo> { Endpoint(.get, "/api/server", timeout: 10) }

        /// GET /api/health: Lidarr, media and library counts, and whether requests are on.
        public static func health() -> Endpoint<HealthStatus> { Endpoint(.get, "/api/health") }

        /// GET /api/musicbrainz/status: the MusicBrainz queue and its wait.
        public static func musicBrainzStatus() -> Endpoint<MusicBrainzStatus> { Endpoint(.get, "/api/musicbrainz/status") }

        /// POST /api/library/refresh (admin): scan every source now.
        public static func refreshLibrary() -> Endpoint<LibraryStats> { Endpoint(.post, "/api/library/refresh", timeout: 300) }
    }
}
