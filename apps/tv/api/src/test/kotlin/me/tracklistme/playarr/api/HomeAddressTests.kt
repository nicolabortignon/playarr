package me.tracklistme.playarr.api

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class HomeAddressTests {
  private val server = MockWebServer()
  private val token = "q2vK8uWm0sZb4N3yRj7tLx5pAe1cDh9fGo6iUk2wQzE"

  private class Network(var state: LocalNetwork.State = LocalNetwork.State(1, true)) : LocalNetwork {
    override val now: LocalNetwork.State get() = state
  }

  @Before fun start() = server.start()
  @After fun stop() = server.close()

  private fun home(network: LocalNetwork = Network()) = HomeAddress(server.url("/").toString().trimEnd('/'), token, OkHttpClient(), network)

  /** The server's answer for the session this token holds: HMAC of "playarr-home-proof:" + the nonce asked with. */
  private fun answering(path: String): MockResponse {
    val nonce = path.substringAfter("nonce=")
    val proof = HomeAddress.base64Url(HomeAddress.hmac(HomeAddress.key(token), HomeAddress.PROOF_MESSAGE + nonce))
    return MockResponse.Builder().code(200).body("""{"proof":"$proof"}""").build()
  }

  @Test fun matchesTheServersWorkedExample() {
    val nonce = "Zm9yLXRoZS10ZXN0LXZlY3Rvci1vbmx5LTAwMDAwMDA"
    val key = HomeAddress.key(token)
    assertEquals("zMeUpoDAZIEdQYfetB3cfbWaBgpXvauknrcPSpZz80w", HomeAddress.id(nonce, key))
    assertTrue(HomeAddress.proves("-HSL_2JeFGzqbuQ_mS3Woz6K3OzGVWUUm8WPkiUP1p4", nonce, key))
    assertFalse(HomeAddress.proves("-HSL_2JeFGzqbuQ_mS3Woz6K3OzGVWUUm8WPkiUP1p4", nonce + "x", key))
    assertFalse(HomeAddress.proves("-HSL_2JeFGzqbuQ_mS3Woz6K3OzGVWUUm8WPkiUP1p4", nonce, HomeAddress.key("another")))
  }

  @Test fun isProvenOnceTheServerAnswersAndAsksWithoutTheToken() = runTest {
    val home = home()
    server.dispatcher = object : mockwebserver3.Dispatcher() {
      override fun dispatch(request: mockwebserver3.RecordedRequest) = answering(request.url.toString())
    }
    assertFalse(home.isProven)
    assertTrue(home.verify())
    assertTrue(home.isProven)
    val asked = server.takeRequest()
    assertEquals("/api/auth/proof", asked.url.encodedPath)
    assertNull(asked.headers["Authorization"])
    assertFalse(asked.url.toString().contains(token))
    // Asked once per network.
    assertTrue(home.verify())
    assertEquals(1, server.requestCount)
  }

  @Test fun isntProvenByAnythingElseNorAwayFromHome() = runTest {
    server.enqueue(MockResponse.Builder().code(200).body("""{"proof":"bm90LWl0"}""").build())
    assertFalse(home().verify())
    assertFalse(home(Network(LocalNetwork.State(1, false))).verify())
    assertEquals(1, server.requestCount)
  }
}
