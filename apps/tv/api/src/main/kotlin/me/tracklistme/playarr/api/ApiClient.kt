package me.tracklistme.playarr.api

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Talks to one server as one account, or as nobody (to sign in): the iOS app's APIClient. Every request carries
 * `X-Playarr: 1` and, with a token, `Authorization: Bearer <token>`; error answers become `ApiError`.
 *
 * `home`: the server's home-network address when `baseUrl` is its public one. A request that can't connect to the public
 * address is tried there once the server there has proven itself (`HomeAddress`), and goes there first afterwards while
 * it stays proven; one that can't connect there goes back.
 */
public class ApiClient(
  public val baseUrl: String,
  public val home: HomeAddress? = null,
  private val token: String? = null,
  private val http: OkHttpClient = OkHttpClient(),
  private val timeoutMillis: Long = 30_000,
  /** Runs when the server answers 401 to a request that carried the token: the session has ended. */
  private val onUnauthorized: suspend () -> Unit = {},
) {
  @Volatile private var homeFirst = false

  public suspend fun <T> send(endpoint: Endpoint<T>): T {
    val (status, body, retryAfter) = try {
      load(endpoint)
    } catch (e: CancellationException) {
      throw e
    } catch (_: IOException) {
      throw ApiError.Offline
    }
    if (status == 401 && token != null) {
      onUnauthorized()
      throw ApiError.Unauthorized
    }
    if (status !in 200..299) throw ApiError.Server(status, message(body, status), retryAfter)
    return try {
      ApiJson.reading.decodeFromString(endpoint.answer, body.ifEmpty { "null" })
    } catch (e: Exception) {
      throw ApiError.Decoding(e.message ?: e.toString())
    }
  }

  private data class Answer(val status: Int, val body: String, val retryAfter: Int?)

  private suspend fun load(endpoint: Endpoint<*>): Answer {
    val home = home ?: return load(endpoint, baseUrl)
    if (homeFirst && home.isProven) {
      try {
        return load(endpoint, home.url)
      } catch (e: IOException) {
        kotlin.coroutines.coroutineContext.ensureActive()
        homeFirst = false
        return load(endpoint, baseUrl)
      }
    }
    try {
      return load(endpoint, baseUrl)
    } catch (e: IOException) {
      kotlin.coroutines.coroutineContext.ensureActive()
      // Only on Wi-Fi or a wired network, and only to the server itself.
      if (!home.verify()) throw e
      val answer = load(endpoint, home.url)
      homeFirst = true
      return answer
    }
  }

  private suspend fun load(endpoint: Endpoint<*>, base: String): Answer {
    // Nothing goes to the home address unless it's proven on the network the TV is on as it goes.
    if (base == home?.url && home?.isProven != true) throw IOException("The home address isn't proven on this network")
    val timeout = endpoint.timeoutMillis ?: timeoutMillis
    val client = http.newBuilder().callTimeout(timeout, TimeUnit.MILLISECONDS).build()
    return client.newCall(request(endpoint, base)).await().use { response ->
      Answer(response.code, response.body.string(), response.header("Retry-After")?.trim()?.toIntOrNull())
    }
  }

  /** The request `send` makes for `endpoint` at `base`. */
  public fun request(endpoint: Endpoint<*>, base: String = baseUrl): Request {
    val builder = Request.Builder()
      .url(url(base, endpoint.path, endpoint.query))
      .header("Accept", "application/json")
      // The server's guard against other sites; Bearer requests are exempt, but it costs nothing.
      .header("X-Playarr", "1")
    token?.let { builder.header("Authorization", "Bearer $it") }
    val body = endpoint.body?.toString()?.toRequestBody(JSON)
    builder.method(endpoint.method.name, body ?: if (endpoint.method == HttpMethod.GET || endpoint.method == HttpMethod.DELETE) null else ByteArray(0).toRequestBody(null))
    return builder.build()
  }

  public companion object {
    private val JSON = "application/json".toMediaType()

    /** `path` (percent-encoded) and `query` on `base`, which may itself have a path ("https://host/playarr"). */
    public fun url(base: String, path: String, query: List<Pair<String, String>>): HttpUrl {
      val encodedQuery = query.joinToString("&") { (name, value) -> Endpoint.segment(name) + "=" + Endpoint.segment(value) }
      return (base.trimEnd('/') + path + if (query.isEmpty()) "" else "?$encodedQuery").toHttpUrl()
    }

    @Serializable private data class ErrorBody(val error: String? = null)

    internal fun message(body: String, status: Int): String =
      try { ApiJson.reading.decodeFromString(ErrorBody.serializer(), body).error } catch (_: Exception) { null } ?: "Request failed ($status)"
  }
}

/** The call, suspended until it answers; cancelling the coroutine cancels the call. */
internal suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
  continuation.invokeOnCancellation { cancel() }
  enqueue(object : Callback {
    override fun onFailure(call: Call, e: IOException) {
      continuation.resumeWithException(e)
    }

    override fun onResponse(call: Call, response: Response) {
      continuation.resume(response) { _, _, _ -> response.close() }
    }
  })
}
