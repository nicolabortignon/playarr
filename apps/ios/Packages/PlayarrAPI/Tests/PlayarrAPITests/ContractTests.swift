import Foundation
import Testing
@testable import PlayarrAPI

/// One recorded server answer and the type the app reads it as.
struct Contract: Sendable, CustomTestStringConvertible {
    let fixture: String
    let decode: @Sendable (Data) throws -> Void

    init<T: Decodable & Sendable>(_ fixture: String, _ type: T.Type) {
        self.fixture = fixture
        self.decode = { _ = try APIClient.decode(T.self, from: $0) }
    }

    var testDescription: String { fixture }
}

/// Real answers, saved by the server's route tests (`RECORD_FIXTURES=1 corepack pnpm -C apps/server test`),
/// decode into the generated types: a change on either side fails here until the other follows.
@Suite struct ContractTests {
    static let contracts: [Contract] = [
        // Server and accounts
        Contract("server-info", ServerInfo.self),
        Contract("auth-sign-in", SignInResponse.self),
        Contract("auth-me", Account.self),
        Contract("accounts", [ListedAccount].self),
        Contract("account-created", CreatedAccount.self),
        Contract("setup-code", SetupCode.self),
        Contract("sessions", [SessionInfo].self),
        Contract("health", HealthStatus.self),
        Contract("musicbrainz-status", MusicBrainzStatus.self),
        // Library and search
        Contract("artists", [Artist].self),
        Contract("artist", ArtistDetail.self),
        Contract("artist-tracks", [Track].self),
        Contract("albums", [Album].self),
        Contract("albums-random", [Album].self),
        Contract("album", AlbumDetail.self),
        Contract("tracks-random", [Track].self),
        Contract("search", SearchResults.self),
        Contract("recent-albums", [Album].self),
        Contract("track-metadata", TrackMetadata.self),
        Contract("lyrics", LyricsAnswer.self),
        // Discover and requests
        Contract("discover-search", DiscoverResults.self),
        Contract("discover-artist", DiscoverArtistDetail.self),
        Contract("discover-similar", [DiscoverArtist].self),
        Contract("artist-lookup", ArtistMatch.self),
        Contract("requests", [AlbumRequest].self),
        Contract("request-created", AlbumRequest.self),
        // Favorites and playlists
        Contract("favorites", [FavoriteTrack].self),
        Contract("playlists", [PlaylistSummary].self),
        Contract("playlist", PlaylistDetail.self),
        Contract("recommendations", Recommendations.self),
        // Settings and analysis
        Contract("settings-sources", SourcesResponse.self),
        Contract("settings-source", SourceInfo.self),
        Contract("folder-access", FolderAccessOptions.self),
        Contract("review-groups", [ReviewGroup].self),
        Contract("matching", MatchingSettings.self),
        Contract("request-settings", RequestSettingsInfo.self),
        Contract("updates", UpdateInfo.self),
        Contract("analysis-progress", AnalysisProgress.self),
        // Playback
        Contract("plays", Recorded.self),
        Contract("levels", [String: TrackLevel].self),
        Contract("transition-ready", TransitionAnswer.self),
        Contract("transition-pending", TransitionAnswer.self),
        Contract("transition-straight", TransitionAnswer.self),
        Contract("transition-unavailable", TransitionAnswer.self),
        Contract("radio", [Track].self),
        Contract("mix-maps", [String: MixMapEntry].self),
        Contract("cues", CuePoints.self),
        // Mixes and stats
        Contract("mixes", [MixSummary].self),
        Contract("mix", MixDetail.self),
        Contract("mix-settings", MixSettingsInfo.self),
        Contract("listenbrainz", ListenBrainzInfo.self),
        Contract("stats", ListeningStats.self),
    ]

    static let fixtures = Bundle.module.url(forResource: "Fixtures", withExtension: nil)

    @Test(arguments: contracts)
    func decodes(_ contract: Contract) throws {
        let folder = try #require(Self.fixtures)
        let data = try Data(contentsOf: folder.appending(path: "\(contract.fixture).json"))
        try contract.decode(data)
    }

    @Test func everyFixtureHasAContract() throws {
        let folder = try #require(Self.fixtures)
        let names = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .map { $0.deletingPathExtension().lastPathComponent }
        #expect(Set(names) == Set(Self.contracts.map(\.fixture)))
    }
}
