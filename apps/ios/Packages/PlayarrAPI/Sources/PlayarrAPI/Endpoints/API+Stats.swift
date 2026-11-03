extension API {
    /// Your listening.
    public enum Stats {
        /// "month", "halfyear", "year", "all" or a calendar year ("2026").
        public static func listening(_ range: StatsRange) -> Endpoint<ListeningStats> {
            Endpoint(.get, "/api/stats", query: [.init(name: "range", value: range)])
        }
    }
}
