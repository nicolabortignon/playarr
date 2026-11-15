package me.tracklistme.playarr.api

import java.io.File
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/**
 * Real answers, saved by the server's route tests (`RECORD_FIXTURES=1 corepack pnpm -C apps/server test`, kept with
 * the iOS app's: apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures), decode into the generated models: a
 * change on either side fails here until the other follows. The same list as the iOS app's ContractTests.swift.
 */
@RunWith(Parameterized::class)
class ContractTests(private val fixture: String, private val type: DeserializationStrategy<*>) {
  companion object {
    private fun <T> list(item: DeserializationStrategy<T>) = ListSerializer(item as kotlinx.serialization.KSerializer<T>)
    private fun <T> map(value: DeserializationStrategy<T>) = MapSerializer(String.serializer(), value as kotlinx.serialization.KSerializer<T>)

    val contracts: List<Pair<String, DeserializationStrategy<*>>> = listOf(
      // Server and accounts
      "server-info" to ServerInfo.serializer(),
      "auth-sign-in" to SignInResponse.serializer(),
      "auth-me" to Account.serializer(),
      "auth-proof" to AuthProof.serializer(),
      "auth-device" to DeviceCodeStart.serializer(),
      "auth-device-approved" to DevicePoll.serializer(),
      "accounts" to list(ListedAccount.serializer()),
      "account-created" to CreatedAccount.serializer(),
      "setup-code" to SetupCode.serializer(),
      "sessions" to list(SessionInfo.serializer()),
      "health" to HealthStatus.serializer(),
      "diagnostics" to ServerDiagnostics.serializer(),
      "musicbrainz-status" to MusicBrainzStatus.serializer(),
      // Library and search
      "artists" to list(Artist.serializer()),
      "artist" to ArtistDetail.serializer(),
      "artist-tracks" to list(Track.serializer()),
      "albums" to list(Album.serializer()),
      "albums-page" to AlbumPage.serializer(),
      "artists-page" to ArtistPage.serializer(),
      "albums-random" to list(Album.serializer()),
      "album" to AlbumDetail.serializer(),
      "tracks-random" to list(Track.serializer()),
      "search" to SearchResults.serializer(),
      "recent-albums" to list(Album.serializer()),
      "track-metadata" to TrackMetadata.serializer(),
      "lyrics" to LyricsAnswer.serializer(),
      // Discover and requests
      "discover-search" to DiscoverResults.serializer(),
      "discover-artist" to DiscoverArtistDetail.serializer(),
      "discover-similar" to list(DiscoverArtist.serializer()),
      "artist-lookup" to ArtistMatch.serializer(),
      "requests" to list(AlbumRequest.serializer()),
      "request-created" to AlbumRequest.serializer(),
      "request-approved" to AlbumRequest.serializer(),
      // Favorites and playlists
      "favorites" to list(FavoriteTrack.serializer()),
      "playlists" to list(PlaylistSummary.serializer()),
      "playlist" to PlaylistDetail.serializer(),
      "playlist-collaborative" to PlaylistDetail.serializer(),
      "playlists-holding" to PlaylistsHolding.serializer(),
      "recommendations" to Recommendations.serializer(),
      // Settings and analysis
      "settings-sources" to SourcesResponse.serializer(),
      "settings-source" to SourceInfo.serializer(),
      "folder-access" to FolderAccessOptions.serializer(),
      "review-groups" to list(ReviewGroup.serializer()),
      "matching" to MatchingSettings.serializer(),
      "request-settings" to RequestSettingsInfo.serializer(),
      "updates" to UpdateInfo.serializer(),
      "reachability" to ReachabilityCheck.serializer(),
      "analysis-progress" to AnalysisProgress.serializer(),
      // Playback
      "plays" to Recorded.serializer(),
      "levels" to map(TrackLevel.serializer()),
      "transition-ready" to TransitionAnswer.serializer(),
      "transition-pending" to TransitionAnswer.serializer(),
      "transition-straight" to TransitionAnswer.serializer(),
      "transition-unavailable" to TransitionAnswer.serializer(),
      "radio" to list(Track.serializer()),
      "lucky" to LuckyMix.serializer(),
      "mix-maps" to map(MixMapEntry.serializer()),
      "cues" to CuePoints.serializer(),
      // Mixes and stats
      "mixes" to list(MixSummary.serializer()),
      "mix" to MixDetail.serializer(),
      "mix-settings" to MixSettingsInfo.serializer(),
      "listenbrainz" to ListenBrainzInfo.serializer(),
      "stats" to ListeningStats.serializer(),
    )

    val fixtures = File(System.getProperty("fixtures") ?: error("The fixtures folder isn't set (api/build.gradle.kts)"))

    @JvmStatic
    @Parameterized.Parameters(name = "{0}")
    fun parameters(): List<Array<Any>> = contracts.map { (name, type) -> arrayOf(name, type) }
  }

  @Test
  fun decodes() {
    val text = File(fixtures, "$fixture.json").readText()
    ApiJson.reading.decodeFromString(type, text.ifEmpty { "null" })
  }

  @Test
  fun everyFixtureHasAContract() {
    val names = fixtures.listFiles { f -> f.extension == "json" }!!.map { it.nameWithoutExtension }.toSet()
    assertEquals(names, contracts.map { it.first }.toSet())
  }
}
