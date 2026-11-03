extension API {
    public enum Search {
        /// GET /api/search: artists, albums and songs in the library.
        public static func library(_ query: String) -> Endpoint<SearchResults> {
            Endpoint(.get, "/api/search", query: [.init(name: "q", value: query)])
        }
    }
}
