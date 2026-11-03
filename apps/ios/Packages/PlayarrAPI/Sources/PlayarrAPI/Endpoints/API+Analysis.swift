extension API {
    /// Settings → Analysis.
    public enum Analysis {
        public static func progress() -> Endpoint<AnalysisProgress> { Endpoint(.get, "/api/analysis/progress") }

        /// Queues every song this analysis hasn't done (nil: every analysis); `again`: every song.
        public static func run(_ kind: AnalysisKind?, again: Bool = false) -> Endpoint<Queued> {
            Endpoint(.post, "/api/analysis/\(kind?.rawValue ?? "all")", body: ["again": again])
        }
    }
}
