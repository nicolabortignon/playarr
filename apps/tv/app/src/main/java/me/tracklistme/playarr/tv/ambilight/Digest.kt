package me.tracklistme.playarr.tv.ambilight

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.Authenticator
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route

/**
 * HTTP Digest authentication (RFC 7616 with MD5, qop=auth), which a Philips TV's JointSpace asks of a paired app.
 * OkHttp has only Basic. Answers a 401's challenge once: a second 401 means the credentials are wrong.
 */
class DigestAuthenticator(
  private val user: String,
  private val password: String,
  private val cnonce: () -> String = ::randomCnonce,
) : Authenticator {
  private val count = AtomicInteger(0)

  override fun authenticate(route: Route?, response: Response): Request? {
    val request = response.request
    if (request.header("Authorization") != null) return null
    val challenge = response.headers("WWW-Authenticate").firstNotNullOfOrNull(Digest::parse) ?: return null
    val uri = request.url.encodedPath + (request.url.encodedQuery?.let { "?$it" } ?: "")
    val header = Digest.header(challenge, request.method, uri, user, password, cnonce(), count.incrementAndGet())
    return request.newBuilder().header("Authorization", header).build()
  }
}

object Digest {
  data class Challenge(val realm: String, val nonce: String, val qop: String?, val opaque: String?, val algorithm: String?)

  private val param = Regex("""(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]*))""")

  /** A Digest challenge we can answer (MD5, and qop auth when it's offered), or null. */
  fun parse(header: String): Challenge? {
    val trimmed = header.trim()
    if (!trimmed.startsWith("Digest ", ignoreCase = true)) return null
    val params = param.findAll(trimmed.substring(7)).associate { m -> m.groupValues[1].lowercase() to (m.groups[2]?.value ?: m.groupValues[3]) }
    val realm = params["realm"] ?: return null
    val nonce = params["nonce"] ?: return null
    val algorithm = params["algorithm"]
    if (algorithm != null && !algorithm.equals("MD5", ignoreCase = true)) return null
    val offered = params["qop"]?.split(',')?.map { it.trim() }
    val qop = when {
      offered == null -> null
      "auth" in offered -> "auth"
      else -> return null
    }
    return Challenge(realm, nonce, qop, params["opaque"], algorithm)
  }

  fun header(c: Challenge, method: String, uri: String, user: String, password: String, cnonce: String, count: Int): String {
    val ha1 = md5("$user:${c.realm}:$password")
    val ha2 = md5("$method:$uri")
    val nc = "%08x".format(count)
    val response = if (c.qop != null) md5("$ha1:${c.nonce}:$nc:$cnonce:${c.qop}:$ha2") else md5("$ha1:${c.nonce}:$ha2")
    return buildString {
      append("Digest username=\"$user\", realm=\"${c.realm}\", nonce=\"${c.nonce}\", uri=\"$uri\", response=\"$response\"")
      if (c.qop != null) append(", qop=${c.qop}, nc=$nc, cnonce=\"$cnonce\"")
      c.opaque?.let { append(", opaque=\"$it\"") }
      c.algorithm?.let { append(", algorithm=$it") }
    }
  }

  private fun md5(s: String): String = MessageDigest.getInstance("MD5").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
}

private val random = SecureRandom()

private fun randomCnonce(): String = ByteArray(8).also(random::nextBytes).joinToString("") { "%02x".format(it) }
