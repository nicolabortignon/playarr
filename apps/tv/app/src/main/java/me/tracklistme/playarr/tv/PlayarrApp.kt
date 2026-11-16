package me.tracklistme.playarr.tv

import android.app.Application
import android.content.Context
import android.os.Build
import android.provider.Settings
import androidx.core.content.edit
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.memory.MemoryCache
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import java.io.File
import me.tracklistme.playarr.api.ApiClient
import me.tracklistme.playarr.api.DeviceInfo
import me.tracklistme.playarr.api.KeyValues
import me.tracklistme.playarr.api.KeystoreSecretStore
import me.tracklistme.playarr.api.MediaUrls
import me.tracklistme.playarr.api.ServerBrowser
import me.tracklistme.playarr.api.ServerStore
import me.tracklistme.playarr.player.SleepTimer
import me.tracklistme.playarr.tv.ambilight.Ambilight
import me.tracklistme.playarr.tv.ambilight.AmbilightStore
import me.tracklistme.playarr.tv.playback.PlaybackSettings
import me.tracklistme.playarr.tv.playback.PlayerConnection
import me.tracklistme.playarr.tv.update.SelfUpdate
import me.tracklistme.playarr.tv.update.selfUpdate
import okhttp3.Cache
import okhttp3.Interceptor
import okhttp3.OkHttpClient

/**
 * The app's one of everything: the servers and accounts on this TV, the HTTP client (with a small disk cache, plan 9
 * §2), Bonjour, and Coil for covers, its memory cache capped at 32 MB (plan 9 §5's budget).
 */
class PlayarrApp : Application(), SingletonImageLoader.Factory {
  val store: ServerStore by lazy { ServerStore(Preferences(this), KeystoreSecretStore(this)) }
  val browser: ServerBrowser by lazy { ServerBrowser(this) }
  val player: PlayerConnection by lazy { PlayerConnection(this) }
  val playback: PlaybackSettings by lazy { PlaybackSettings(this) }
  val sleep: SleepTimer by lazy { SleepTimer() }
  val ambilight: Ambilight by lazy { Ambilight(AmbilightStore(this, KeystoreSecretStore(this)), http, device.name) }
  /** Updating from GitHub releases (Settings → About), in the sideload flavor; null in the play flavor. */
  val updates: SelfUpdate? by lazy { selfUpdate(this) }

  val http: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .cache(Cache(File(cacheDir, "http"), 20L * 1024 * 1024))
      .addInterceptor(MediaAuth { media() })
      .build()
  }

  /** The player's: songs are kept in its own cache (PlaybackCache), not with the covers and API answers. */
  val songHttp: OkHttpClient by lazy { http.newBuilder().cache(null).build() }

  val device: DeviceInfo by lazy {
    val name = Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() } ?: "${Build.MANUFACTURER} ${Build.MODEL}"
    DeviceInfo(name.take(80))
  }

  /** The client for whoever's listening; null before anyone has signed in. Its 401 signs that account out here. */
  fun client(): ApiClient? {
    val state = store.current.value
    val server = state.server ?: return null
    val account = state.account ?: return null
    val token = store.token(server.id, account.id) ?: return null
    return ApiClient(server.baseUrl, token = token, http = http, onUnauthorized = { store.signedOut(server.id, account.id) })
  }

  /** Addresses of the listening server's songs and covers, with its token for them. */
  fun media(): MediaUrls? {
    val state = store.current.value
    val server = state.server ?: return null
    val account = state.account ?: return null
    return MediaUrls(server.baseUrl, token = store.token(server.id, account.id))
  }

  override fun newImageLoader(context: PlatformContext): ImageLoader =
    ImageLoader.Builder(context)
      .memoryCache { MemoryCache.Builder().maxSizeBytes(32L * 1024 * 1024).build() }
      .components { add(OkHttpNetworkFetcherFactory(callFactory = { http })) }
      .build()
}

/**
 * The token on requests for the listening server's covers, songs and transitions, and nowhere else (MediaUrls.headers).
 * API calls carry their own (ApiClient), or none on purpose (signing in, the home-address proof).
 */
private class MediaAuth(private val media: () -> MediaUrls?) : Interceptor {
  override fun intercept(chain: Interceptor.Chain): okhttp3.Response {
    val request = chain.request()
    if (request.header("Authorization") != null || request.url.encodedPath.startsWith("/api/")) return chain.proceed(request)
    val headers = media()?.headers(request.url.toString()).orEmpty()
    return chain.proceed(headers.entries.fold(request.newBuilder()) { b, (k, v) -> b.header(k, v) }.build())
  }
}

/** The app's preferences as KeyValues for the ServerStore. */
private class Preferences(context: Context) : KeyValues {
  private val prefs = context.getSharedPreferences("playarr", Context.MODE_PRIVATE)
  override fun get(key: String): String? = prefs.getString(key, null)
  override fun set(key: String, value: String?) = prefs.edit { if (value == null) remove(key) else putString(key, value) }
}

val Context.playarr: PlayarrApp get() = applicationContext as PlayarrApp
