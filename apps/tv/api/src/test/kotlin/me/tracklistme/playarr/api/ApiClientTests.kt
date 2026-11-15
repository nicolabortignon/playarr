package me.tracklistme.playarr.api

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ApiClientTests {
  private val server = MockWebServer()

  @Before fun start() = server.start()
  @After fun stop() = server.close()

  private fun client(token: String? = "tok", onUnauthorized: suspend () -> Unit = {}) =
    ApiClient(server.url("/").toString().trimEnd('/'), token = token, onUnauthorized = onUnauthorized)

  private fun answer(code: Int, body: String = "", retryAfter: String? = null) =
    server.enqueue(MockResponse.Builder().code(code).body(body).apply { retryAfter?.let { addHeader("Retry-After", it) } }.build())

  @Test fun sendsTheGuardAndTheTokenAndReadsTheAnswer() = runTest {
    answer(200, """{"recorded":2}""")
    val recorded = client().send(Api.Playback.reportPlays(emptyList()))
    assertEquals(Recorded(2), recorded)
    val request = server.takeRequest()
    assertEquals("POST", request.method)
    assertEquals("/api/plays", request.url.encodedPath)
    assertEquals("1", request.headers["X-Playarr"])
    assertEquals("Bearer tok", request.headers["Authorization"])
    assertEquals("""{"plays":[]}""", request.body?.utf8())
  }

  @Test fun encodesQueriesAndSegmentsAsTheWebDoes() = runTest {
    answer(200, "[]")
    client().send(Api.Discover.similarArtists("a b:c"))
    assertEquals("/api/discover/artists/a%20b%3Ac/similar", server.takeRequest().url.encodedPath)
    answer(200, """{"artists":[],"albums":[],"tracks":[]}""")
    runCatching { client().send(Api.Search.library("sigur rós & co")) }
    assertEquals("q=sigur%20r%C3%B3s%20%26%20co", server.takeRequest().url.encodedQuery)
  }

  @Test fun aNoContentAnswerReadsAsNoContent() = runTest {
    answer(204)
    assertSame(NoContent, client().send(Api.Favorites.remove("rec-1")))
  }

  @Test fun anErrorCarriesTheServersMessageAndRetryAfter() = runTest {
    answer(503, """{"error":"Too many encodes"}""", retryAfter = "4")
    val error = runCatching { client().send(Api.Library.album(1)) }.exceptionOrNull()
    assertEquals(ApiError.Server(503, "Too many encodes", 4), error)
  }

  @Test fun a401WithATokenEndsTheSession() = runTest {
    var ended = false
    answer(401, """{"error":"Sign in"}""")
    val error = runCatching { client { ended = true }.send(Api.Auth.me()) }.exceptionOrNull()
    assertSame(ApiError.Unauthorized, error)
    assertTrue(ended)
    // Without a token, a 401 is the server's answer (a wrong password).
    answer(401, """{"error":"Wrong password"}""")
    assertEquals(ApiError.Server(401, "Wrong password"), runCatching { client(token = null).send(Api.Auth.me()) }.exceptionOrNull())
  }

  @Test fun noAnswerIsOffline() = runTest {
    val gone = ApiClient("http://127.0.0.1:9", timeoutMillis = 2_000)
    assertSame(ApiError.Offline, runCatching { gone.send(Api.Server.info()) }.exceptionOrNull())
  }

  @Test fun aBaseWithAPathKeepsIt() {
    assertEquals("https://host/playarr/api/albums?sort=recent", ApiClient.url("https://host/playarr/", "/api/albums", listOf("sort" to "recent")).toString())
    assertNull(ApiClient(server.url("/").toString(), token = null).request(Api.Auth.me()).header("Authorization"))
  }
}
