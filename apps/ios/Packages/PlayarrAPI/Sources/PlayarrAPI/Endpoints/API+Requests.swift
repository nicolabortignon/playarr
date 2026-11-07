extension API {
    /// Album requests (Lidarr), when requests are on and the account may request. A member's list holds the requests they
    /// asked for; an admin's every request, those waiting for an answer first.
    public enum Requests {
        public static func list() -> Endpoint<[AlbumRequest]> { Endpoint(.get, "/api/requests") }
        public static func request(_ album: AlbumRef) -> Endpoint<AlbumRequest> { Endpoint(.post, "/api/requests", body: album) }

        /// Off the account's list (an admin's: off everyone's).
        public static func remove(mbid: String) -> Endpoint<NoContent> {
            Endpoint(.delete, "/api/requests/\(Endpoint<NoContent>.segment(mbid))")
        }

        /// An admin's yes to a request waiting for approval: it goes to Lidarr.
        public static func approve(mbid: String) -> Endpoint<AlbumRequest> {
            Endpoint(.post, "/api/requests/\(Endpoint<AlbumRequest>.segment(mbid))/approve")
        }

        /// An admin's no: whoever asked sees it declined.
        public static func decline(mbid: String) -> Endpoint<AlbumRequest> {
            Endpoint(.post, "/api/requests/\(Endpoint<AlbumRequest>.segment(mbid))/decline")
        }

        /// The account has looked at these of its requests as they are now, so they're no longer news (the badge on Requests).
        public static func seen(mbids: [String]) -> Endpoint<NoContent> {
            Endpoint(.post, "/api/requests/seen", body: RequestsSeen(mbids: mbids))
        }
    }
}
