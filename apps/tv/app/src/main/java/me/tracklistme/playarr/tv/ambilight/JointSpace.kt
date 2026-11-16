package me.tracklistme.playarr.tv.ambilight

import android.util.Log
import java.io.IOException
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * A Philips TV's JointSpace API (version 6), as the app on the TV uses it to drive the Ambilight (plan 9 §6). Over
 * HTTPS on 1926 the TV asks for pairing (a PIN it shows, then Digest credentials for this app); some firmwares also
 * answer plain HTTP on 1925 without it.
 */
class JointSpace(val base: HttpUrl, private val http: OkHttpClient) {
  /** This app as the TV lists it among paired devices. */
  data class Device(val id: String, val name: String)

  /** A pairing under way: the TV is showing its PIN. */
  data class Pairing(val device: Device, val authKey: String, val timestamp: Long)

  data class Credentials(val user: String, val password: String)

  class Failure(message: String, val status: Int = 0) : IOException(message)

  /** The same TV with this app's credentials, answering its Digest challenges. */
  fun signedIn(credentials: Credentials?): JointSpace =
    if (credentials == null) this else JointSpace(base, http.newBuilder().authenticator(DigestAuthenticator(credentials.user, credentials.password)).build())

  /** The TV's description; a JointSpace TV answers it without pairing. */
  suspend fun system(): JsonObject = get("system")

  /** Whether the Ambilight needs this app paired: a 401 where an unpaired call is refused. */
  suspend fun needsPairing(): Boolean = try {
    get("ambilight/mode")
    false
  } catch (e: Failure) {
    if (e.status == 401) true else throw e
  }

  suspend fun pairRequest(device: Device): Pairing {
    val answer = post("pair/request", buildJsonObject {
      putJsonObject("access") { putJsonArray("scope") { add(JsonPrimitive("read")); add(JsonPrimitive("write")); add(JsonPrimitive("control")) } }
      put("device", device.json())
    })
    if (answer.string("error_id") != "SUCCESS") throw Failure(answer.string("error_text") ?: "The TV refused to pair")
    return Pairing(device, answer.string("auth_key") ?: throw Failure("No key from the TV"), answer["timestamp"]!!.jsonPrimitive.long)
  }

  /** Finishes pairing with the PIN the TV showed; these credentials sign every call after. */
  suspend fun pairGrant(pairing: Pairing, pin: String): Credentials {
    val credentials = Credentials(pairing.device.id, pairing.authKey)
    val answer = signedIn(credentials).post("pair/grant", buildJsonObject {
      putJsonObject("auth") {
        put("auth_appId", "1")
        put("pin", pin)
        put("auth_timestamp", pairing.timestamp)
        put("auth_signature", signature(pairing.timestamp, pin))
      }
      put("device", pairing.device.json())
    })
    if (answer.string("error_id") != "SUCCESS") throw Failure(answer.string("error_text") ?: "The TV didn't take the PIN")
    return credentials
  }

  /** The Ambilight's mode: `internal` (following the picture), `manual` (colors sent here), `expert` and others. */
  suspend fun mode(): String? = get("ambilight/mode").string("current")
  suspend fun setMode(mode: String) { post("ambilight/mode", buildJsonObject { put("current", mode) }) }

  /** The style the owner chose (follow video, audio or a color), to give back. Null where the firmware has none. */
  suspend fun configuration(): JsonObject? = runCatching { get("ambilight/currentconfiguration") }.getOrNull()
  suspend fun setConfiguration(configuration: JsonObject) { post("ambilight/currentconfiguration", configuration) }

  /** "On" or "Off": with the lights off, Playarr leaves them off. */
  suspend fun power(): String? = runCatching { get("ambilight/power").string("power") }.getOrNull()

  suspend fun topology(): Topology {
    val t = get("ambilight/topology")
    fun n(key: String) = t[key]?.jsonPrimitive?.intOrNull ?: 0
    return Topology(layers = n("layers").coerceAtLeast(1), left = n("left"), top = n("top"), right = n("right"), bottom = n("bottom"))
  }

  /** Lights each side (in manual mode). */
  suspend fun show(colors: Sides, topology: Topology) { post("ambilight/cached", AmbilightColors.body(colors, topology)) }

  private suspend fun get(path: String): JsonObject = call(Request.Builder().url(url(path)).get().build())

  private suspend fun post(path: String, body: JsonObject): JsonObject =
    call(Request.Builder().url(url(path)).post(body.toString().toRequestBody(JSON)).build())

  private fun url(path: String): HttpUrl = base.resolve(path) ?: throw Failure("Bad path $path")

  private suspend fun call(request: Request): JsonObject = withContext(Dispatchers.IO) {
    http.newCall(request).execute().use { response ->
      val text = response.body.string()
      if (!response.isSuccessful) throw Failure("The TV answered ${response.code}", response.code)
      // Some calls answer nothing, or a word: only JSON objects are read.
      runCatching { Json.parseToJsonElement(text).jsonObject }.getOrDefault(JsonObject(emptyMap()))
    }
  }

  private fun Device.json(): JsonObject = buildJsonObject {
    put("device_name", name)
    put("device_os", "Android")
    put("app_id", "me.tracklistme.playarr.tv")
    put("app_name", "Playarr")
    put("type", "native")
    put("id", id)
  }

  companion object {
    private val JSON = "application/json".toMediaType()

    /** JointSpace's shared key for pairing signatures (the same in every TV; Home Assistant's library uses it too). */
    private val SHARED_KEY: ByteArray = Base64.getDecoder().decode("ZmVay1EQVFOaZhwQ4Kv81ypLAZNczV9sG4KkseXWn1NEk6cXmPKO/MCa9sryslvLCFMnNe4Z4CPXzToowvhHvA==")

    /** base64(HMAC-SHA1(shared key, timestamp + PIN)). */
    fun signature(timestamp: Long, pin: String): String {
      val mac = Mac.getInstance("HmacSHA1").apply { init(SecretKeySpec(SHARED_KEY, "HmacSHA1")) }
      return Base64.getEncoder().encodeToString(mac.doFinal("$timestamp$pin".toByteArray()))
    }

    /** Where to look: HTTPS on 1926 then HTTP on 1925, at each of the TV's own addresses. */
    fun candidates(hosts: List<String>): List<HttpUrl> =
      hosts.map { "https://$it:1926/6/" }.plus(hosts.map { "http://$it:1925/6/" }).mapNotNull { it.toHttpUrlOrNull() }

    /** The first address that answers as JointSpace, each tried briefly. */
    suspend fun find(http: OkHttpClient, hosts: List<String> = TvAddresses.all()): JointSpace? {
      val quick = http.newBuilder().connectTimeout(1500, TimeUnit.MILLISECONDS).readTimeout(3, TimeUnit.SECONDS).build()
      for (base in candidates(hosts)) {
        val space = JointSpace(base, quick)
        runCatching { space.system() }
          .onSuccess { return JointSpace(base, http) }
          .onFailure { Log.d("PlayarrAmbilight", "No JointSpace at $base: $it") }
      }
      return null
    }
  }
}

private fun JsonObject.string(key: String): String? = this[key]?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
