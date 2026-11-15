package me.tracklistme.playarr.api

import java.util.TimeZone
import kotlinx.serialization.Serializable
import me.tracklistme.playarr.api.Endpoint.Companion.call
import me.tracklistme.playarr.api.Endpoint.Companion.get
import me.tracklistme.playarr.api.Endpoint.Companion.items
import me.tracklistme.playarr.api.Endpoint.Companion.segment
import me.tracklistme.playarr.api.Endpoint.Companion.send

/**
 * The endpoints the TV calls, grouped by feature as the iOS app's `API`: `client.send(Api.Library.album(12))`.
 * Admin settings (sources, accounts, analysis, updates) stay on the phone and the web (plan 9 §5).
 */
public object Api {
  /** Signing in and out. Sign-in and proof go without a token. */
  public object Auth {
    /** POST /api/auth/sign-in. */
    public fun signIn(username: String, password: String, device: DeviceInfo): Endpoint<SignInResponse> =
      send(HttpMethod.POST, "/api/auth/sign-in", SignInBody(username, password, device.name, device.platform))

    /** POST /api/auth/sign-out: ends this session. */
    public fun signOut(): Endpoint<NoContent> = call(HttpMethod.POST, "/api/auth/sign-out")

    /** GET /api/auth/me: the signed-in account. */
    public fun me(): Endpoint<Account> = get("/api/auth/me")

    /** POST /api/auth/device: a code for signing this TV in from a phone or the web (plan 9 §3). */
    public fun startDevice(device: DeviceInfo): Endpoint<DeviceCodeStart> =
      send(HttpMethod.POST, "/api/auth/device", DeviceBody(device.name, device.platform))

    /** POST /api/auth/device/poll: pending, approved with this TV's own session, or expired. */
    public fun pollDevice(pollToken: String): Endpoint<DevicePoll> = send(HttpMethod.POST, "/api/auth/device/poll", PollBody(pollToken))

    /** GET /api/auth/proof: the server at a home address proving it holds a session (`HomeAddress`). */
    public fun proof(id: String, nonce: String): Endpoint<AuthProof> = get("/api/auth/proof", items("id" to id, "nonce" to nonce))

    @Serializable internal data class DeviceBody(val device: String, val platform: String)
    @Serializable internal data class PollBody(val pollToken: String)
    @Serializable internal data class SignInBody(val username: String, val password: String, val device: String, val platform: String)
  }

  /** The server itself. */
  public object Server {
    /** GET /api/server: id, name, version, the oldest apps it serves, setup mode. Answered without signing in. */
    public fun info(): Endpoint<ServerInfo> = get("/api/server", timeoutMillis = 10_000)

    /** GET /api/health: Lidarr, media and library counts, and whether requests are on. */
    public fun health(): Endpoint<HealthStatus> = get("/api/health")
  }

  /** Browsing the library. */
  public object Library {
    public fun artists(): Endpoint<List<Artist>> = get("/api/artists")
    public fun artist(id: Int): Endpoint<ArtistDetail> = get("/api/artists/$id")
    public fun artistTracks(id: Int): Endpoint<List<Track>> = get("/api/artists/$id/tracks")

    public fun albums(sort: AlbumSort, limit: Int? = null): Endpoint<List<Album>> =
      get("/api/albums", items("sort" to sort.value, "limit" to limit?.toString()))

    /** `limit` albums in `sort`'s order from `offset` (0 first): a page, or all of them from an older server. */
    public fun albumPage(sort: AlbumSort, offset: Int, limit: Int): Endpoint<AlbumsAnswer> =
      get("/api/albums", listOf("sort" to sort.value, "offset" to offset.toString(), "limit" to limit.toString()))

    public fun randomAlbums(limit: Int = 12): Endpoint<List<Album>> = get("/api/albums/random", listOf("limit" to limit.toString()))
    public fun album(id: Int): Endpoint<AlbumDetail> = get("/api/albums/$id")
    public fun randomTracks(limit: Int = 50): Endpoint<List<Track>> = get("/api/tracks/random", listOf("limit" to limit.toString()))

    /** Jump back in: albums heard lately. */
    public fun recentAlbums(): Endpoint<List<Album>> = get("/api/plays/recent-albums")

    public fun lyrics(trackId: Int): Endpoint<LyricsAnswer> = get("/api/tracks/$trackId/lyrics")
  }

  public object Search {
    /** GET /api/search: artists, albums and songs in the library. */
    public fun library(query: String): Endpoint<SearchResults> = get("/api/search", listOf("q" to query))
  }

  /** What the player asks for: plays, levels, transitions, radio and mix maps. */
  public object Playback {
    public fun reportPlays(plays: List<PlayReport>): Endpoint<Recorded> = send(HttpMethod.POST, "/api/plays", PlaysBody(plays))

    /** Even volume: gains for up to 50 recordings. */
    public fun levels(ids: List<String>): Endpoint<Map<String, TrackLevel>> = send(HttpMethod.POST, "/api/levels", IdsBody(ids))

    public fun transition(request: TransitionRequest): Endpoint<TransitionAnswer> = send(HttpMethod.POST, "/api/transitions", request)

    /** Songs like the seeds, from the library. */
    public fun radio(seeds: List<String>, exclude: List<String> = emptyList(), count: Int = 25): Endpoint<List<Track>> =
      send(HttpMethod.POST, "/api/radio", RadioBody(seeds, exclude, count))

    /** Mix maps for up to 50 recordings, with any cue points set by hand. */
    public fun mixMaps(ids: List<String>): Endpoint<Map<String, MixMapEntry>> = send(HttpMethod.POST, "/api/mix-maps", IdsBody(ids))

    @Serializable internal data class PlaysBody(val plays: List<PlayReport>)
    @Serializable internal data class IdsBody(val ids: List<String>)
    @Serializable internal data class RadioBody(val seeds: List<String>, val exclude: List<String>, val count: Int)
  }

  /** Made for you. Each call says the device's time zone: mixes follow the listener's clock. */
  public object Mixes {
    public fun list(zone: TimeZone = TimeZone.getDefault()): Endpoint<List<MixSummary>> = get("/api/mixes", tz(zone))
    public fun get(key: String, zone: TimeZone = TimeZone.getDefault()): Endpoint<MixDetail> = get("/api/mixes/${segment(key)}", tz(zone))

    /** Feeling lucky: 15 songs put together now; a new set every time. */
    public fun lucky(zone: TimeZone = TimeZone.getDefault()): Endpoint<LuckyMix> = call(HttpMethod.POST, "/api/lucky", tz(zone))

    private fun tz(zone: TimeZone) = listOf("tz" to zone.id)
  }

  /** Music not in the library yet (MusicBrainz, through the server). */
  public object Discover {
    public fun search(query: String): Endpoint<DiscoverResults> = get("/api/discover/search", listOf("q" to query))
    public fun artist(mbid: String): Endpoint<DiscoverArtistDetail> = get("/api/discover/artists/${segment(mbid)}")
    public fun similarArtists(mbid: String): Endpoint<List<DiscoverArtist>> = get("/api/discover/artists/${segment(mbid)}/similar")
    public fun findArtist(name: String): Endpoint<ArtistMatch> = get("/api/discover/artist-lookup", listOf("name" to name))
  }

  public object Favorites {
    public fun list(): Endpoint<List<FavoriteTrack>> = get("/api/favorites")

    /** `favoritedAt`: when a song taken back was first favorited, so it goes back where it was; null for one favorited now. */
    public fun add(recordingId: String, favoritedAt: String? = null): Endpoint<NoContent> =
      if (favoritedAt == null) call(HttpMethod.PUT, "/api/favorites/${segment(recordingId)}")
      else send(HttpMethod.PUT, "/api/favorites/${segment(recordingId)}", FavoritedAt(favoritedAt))

    public fun remove(recordingId: String): Endpoint<NoContent> = call(HttpMethod.DELETE, "/api/favorites/${segment(recordingId)}")

    @Serializable internal data class FavoritedAt(val favoritedAt: String)
  }

  public object Playlists {
    public fun list(): Endpoint<List<PlaylistSummary>> = get("/api/playlists")
    public fun get(id: Int): Endpoint<PlaylistDetail> = get("/api/playlists/$id")

    public fun addItems(id: Int, recordingIds: List<String>): Endpoint<PlaylistDetail> =
      send(HttpMethod.POST, "/api/playlists/$id/items", RecordingIds(recordingIds))

    /** How many of these songs each playlist the account can add to already holds. */
    public fun holding(recordingIds: List<String>): Endpoint<PlaylistsHolding> =
      send(HttpMethod.POST, "/api/playlists/holding", RecordingIds(recordingIds))

    @Serializable internal data class RecordingIds(val recordingIds: List<String>)
  }

  /** Album requests (Lidarr), when requests are on and the account may request (`Account.requestAccess`). */
  public object Requests {
    public fun list(): Endpoint<List<AlbumRequest>> = get("/api/requests")
    public fun request(album: AlbumRef): Endpoint<AlbumRequest> = send(HttpMethod.POST, "/api/requests", album)
    public fun remove(mbid: String): Endpoint<NoContent> = call(HttpMethod.DELETE, "/api/requests/${segment(mbid)}")

    /** The account has looked at these of its requests as they are now (the badge on Requests). */
    public fun seen(mbids: List<String>): Endpoint<NoContent> = send(HttpMethod.POST, "/api/requests/seen", RequestsSeen(mbids = mbids))
  }

  /** Your listening. */
  public object Stats {
    /** "month", "halfyear", "year", "all" or a calendar year ("2026"). */
    public fun listening(range: StatsRange): Endpoint<ListeningStats> = get("/api/stats", listOf("range" to range))
  }
}

/** POST /api/transitions: `from` into `to` (catalog song ids), as the iOS app's TransitionRequest. */
@Serializable
public data class TransitionRequest(
  val from: Int,
  val to: Int,
  val mode: MixMode,
  /** Where `from` is now, so the plan doesn't start in the past. */
  val position: Double? = null,
  /** The files the player has, so the server never renders from another one. */
  val fromFileId: Int? = null,
  val toFileId: Int? = null,
  /** The listener's fade length, for songs that can't be mixed on the beat. */
  val fade: Double? = null,
  /** The queue plays the songs' album (songs of one album in order go straight on). */
  val albumQueue: Boolean? = null,
  /** The gains (dB) the player plays each song at. */
  val levels: TransitionAnswer.Ready.Levels? = null,
)
