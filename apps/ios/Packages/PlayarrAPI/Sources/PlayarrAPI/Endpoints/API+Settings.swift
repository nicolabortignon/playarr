extension API {
    /// Settings: sources, matching, requests, updates (admin), mixes and ListenBrainz (per account).
    public enum Settings {
        public static func sources() -> Endpoint<SourcesResponse> { Endpoint(.get, "/api/settings/sources") }
        public static func addSource(_ input: SourceInput) -> Endpoint<SourceInfo> { Endpoint(.post, "/api/settings/sources", body: input) }
        public static func updateSource(id: Int, _ input: SourceInput) -> Endpoint<SourceInfo> { Endpoint(.patch, "/api/settings/sources/\(id)", body: input) }
        public static func removeSource(id: Int) -> Endpoint<NoContent> { Endpoint(.delete, "/api/settings/sources/\(id)") }
        public static func reorderSources(ids: [Int]) -> Endpoint<SourcesResponse> { Endpoint(.put, "/api/settings/sources/order", body: ["ids": ids]) }

        public static func testSource(id: Int? = nil, url: String? = nil, apiKey: String? = nil) -> Endpoint<SourceTestResult> {
            Endpoint(.post, "/api/settings/sources/test", body: TestBody(id: id, url: url, apiKey: apiKey))
        }

        public static func rescanSource(id: Int) -> Endpoint<NoContent> { Endpoint(.post, "/api/settings/sources/\(id)/rescan") }
        public static func rematchSource(id: Int) -> Endpoint<NoContent> { Endpoint(.post, "/api/settings/sources/\(id)/rematch") }
        public static func browseFolders(_ request: FolderBrowseRequest) -> Endpoint<FolderListing> { Endpoint(.post, "/api/settings/folders/browse", body: request) }
        public static func folderAccess() -> Endpoint<FolderAccessOptions> { Endpoint(.get, "/api/settings/folders/access") }
        public static func review(sourceId: Int) -> Endpoint<[ReviewGroup]> { Endpoint(.get, "/api/settings/sources/\(sourceId)/review") }

        public static func reviewAction(sourceId: Int, _ action: ReviewAction) -> Endpoint<NoContent> {
            Endpoint(.post, "/api/settings/sources/\(sourceId)/review", body: action)
        }

        public static func organizePlan(sourceId: Int) -> Endpoint<OrganizePlan> { Endpoint(.get, "/api/settings/sources/\(sourceId)/organize") }

        public static func organize(sourceId: Int, moves: [String]) -> Endpoint<OrganizeResult> {
            Endpoint(.post, "/api/settings/sources/\(sourceId)/organize", body: ["moves": moves])
        }

        public static func undoOrganize(sourceId: Int, batchId: Int) -> Endpoint<Restored> {
            Endpoint(.post, "/api/settings/sources/\(sourceId)/organize/undo", body: ["batchId": batchId])
        }

        public static func matching() -> Endpoint<MatchingSettings> { Endpoint(.get, "/api/settings/matching") }
        public static func saveMatching(acoustidKey: String) -> Endpoint<MatchingSettings> { Endpoint(.put, "/api/settings/matching", body: ["acoustidKey": acoustidKey]) }
        public static func requests() -> Endpoint<RequestSettingsInfo> { Endpoint(.get, "/api/settings/requests") }
        public static func saveRequests(_ patch: RequestSettingsPatch) -> Endpoint<RequestSettingsInfo> { Endpoint(.put, "/api/settings/requests", body: patch) }
        public static func updates() -> Endpoint<UpdateInfo> { Endpoint(.get, "/api/settings/updates") }
        public static func saveUpdates(_ patch: UpdateSettingsPatch) -> Endpoint<UpdateInfo> { Endpoint(.put, "/api/settings/updates", body: patch) }
        public static func checkForUpdates() -> Endpoint<UpdateInfo> { Endpoint(.post, "/api/settings/updates/check") }
        public static func mixes() -> Endpoint<MixSettingsInfo> { Endpoint(.get, "/api/settings/mixes") }
        public static func saveMixes(_ patch: MixSettingsPatch) -> Endpoint<MixSettingsInfo> { Endpoint(.put, "/api/settings/mixes", body: patch) }
        /// Forgets everything played; the mixes are made again.
        public static func clearHistory() -> Endpoint<MixSettingsInfo> { Endpoint(.delete, "/api/settings/mixes/history") }
        public static func listenBrainz() -> Endpoint<ListenBrainzInfo> { Endpoint(.get, "/api/settings/listenbrainz") }

        public static func saveListenBrainz(token: String? = nil, enabled: Bool? = nil) -> Endpoint<ListenBrainzInfo> {
            Endpoint(.put, "/api/settings/listenbrainz", body: ListenBrainzBody(token: token, enabled: enabled))
        }

        public static func disconnectListenBrainz() -> Endpoint<ListenBrainzInfo> { Endpoint(.delete, "/api/settings/listenbrainz") }
        public static func sendEarlierListens() -> Endpoint<ListenBrainzInfo> { Endpoint(.post, "/api/settings/listenbrainz/earlier") }

        private struct TestBody: Encodable, Sendable {
            let id: Int?
            let url: String?
            let apiKey: String?
        }

        private struct ListenBrainzBody: Encodable, Sendable {
            let token: String?
            let enabled: Bool?
        }
    }
}
