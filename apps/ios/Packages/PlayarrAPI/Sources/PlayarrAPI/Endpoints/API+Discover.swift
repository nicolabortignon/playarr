extension API {
    /// Music not in the library yet (MusicBrainz, through the server).
    public enum Discover {
        public static func search(_ query: String) -> Endpoint<DiscoverResults> {
            Endpoint(.get, "/api/discover/search", query: [.init(name: "q", value: query)])
        }

        public static func artist(mbid: String) -> Endpoint<DiscoverArtistDetail> {
            Endpoint(.get, "/api/discover/artists/\(Endpoint<DiscoverArtistDetail>.segment(mbid))")
        }

        public static func similarArtists(mbid: String) -> Endpoint<[DiscoverArtist]> {
            Endpoint(.get, "/api/discover/artists/\(Endpoint<[DiscoverArtist]>.segment(mbid))/similar")
        }

        public static func findArtist(name: String) -> Endpoint<ArtistMatch> {
            Endpoint(.get, "/api/discover/artist-lookup", query: [.init(name: "name", value: name)])
        }
    }
}
