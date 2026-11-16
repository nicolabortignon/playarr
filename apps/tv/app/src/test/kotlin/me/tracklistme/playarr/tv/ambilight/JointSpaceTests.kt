package me.tracklistme.playarr.tv.ambilight

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class JointSpaceTests {
  private val server = MockWebServer()

  @Before fun start() = server.start()
  @After fun stop() = server.close()

  private fun space() = JointSpace(server.url("/6/"), OkHttpClient())

  @Test fun signsAsHomeAssistantsLibraryDoes() {
    assertEquals("8zonvR9eBC+K6AVXERtf7xim+30=", JointSpace.signature(1_700_000_000, "4711"))
  }

  @Test fun pairsWithThePinAndDigest() = runBlocking {
    server.enqueue(MockResponse.Builder().body("""{"error_id":"SUCCESS","auth_key":"secret","timestamp":1700000000,"timeout":60}""").build())
    server.enqueue(MockResponse.Builder().code(401).addHeader("WWW-Authenticate", """Digest realm="XTV", qop="auth,auth-int", nonce="n1"""").build())
    server.enqueue(MockResponse.Builder().body("""{"error_id":"SUCCESS"}""").build())
    val pairing = space().pairRequest(JointSpace.Device("dev1", "Living room"))
    assertEquals("secret", pairing.authKey)
    val request = server.takeRequest()
    assertEquals("/6/pair/request", request.url.encodedPath)
    val sent = Json.parseToJsonElement(request.body!!.utf8()).jsonObject
    assertEquals("dev1", sent["device"]!!.jsonObject["id"]!!.jsonPrimitive.content)

    val credentials = space().pairGrant(pairing, "4711")
    assertEquals(JointSpace.Credentials("dev1", "secret"), credentials)
    server.takeRequest()
    val signed = server.takeRequest()
    assertTrue(signed.headers["Authorization"]!!.startsWith("Digest username=\"dev1\", realm=\"XTV\""))
    val auth = Json.parseToJsonElement(signed.body!!.utf8()).jsonObject["auth"]!!.jsonObject
    assertEquals("8zonvR9eBC+K6AVXERtf7xim+30=", auth["auth_signature"]!!.jsonPrimitive.content)
    assertEquals("4711", auth["pin"]!!.jsonPrimitive.content)
  }

  @Test fun aRefusedCallMeansPairing() = runBlocking {
    server.enqueue(MockResponse.Builder().code(401).addHeader("WWW-Authenticate", """Digest realm="XTV", nonce="n"""").build())
    assertTrue(space().needsPairing())
  }

  @Test fun looksForHttpsFirstThenPlainHttp() {
    val bases = JointSpace.candidates(listOf("127.0.0.1", "192.168.1.42"))
    assertEquals(
      listOf("https://127.0.0.1:1926/6/", "https://192.168.1.42:1926/6/", "http://127.0.0.1:1925/6/", "http://192.168.1.42:1925/6/"),
      bases.map { it.toString() },
    )
  }
}
