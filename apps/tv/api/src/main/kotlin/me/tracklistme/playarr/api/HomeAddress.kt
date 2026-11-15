package me.tracklistme.playarr.api

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient

/** The network the TV is on: whether it's a home one (Wi-Fi or wired), and a number that changes when it changes. */
public interface LocalNetwork {
  public data class State(val generation: Int, val isLocal: Boolean)

  public val now: State

  public suspend fun current(): State = now
}

/**
 * A server's home-network address, tried when its public address can't be reached, and whether this account's token may
 * go there on the network the TV is on now (the iOS app's HomeAddress; docs/server/accounts-and-access.md, "The home
 * address"): only on Wi-Fi or a wired network, and only once whatever answers there has proven it's the server holding
 * this account's session.
 *
 * The proof (`GET /api/auth/proof`): the app sends a fresh nonce and names its session by HMAC-SHA256(key: the token's
 * SHA-256, "playarr-home-id:" + nonce); the server, which stores only that SHA-256, answers HMAC-SHA256(the same key,
 * "playarr-home-proof:" + nonce). A proof holds while the TV stays on that network, an answer that proves nothing for
 * 10 minutes, no answer for 30 s.
 */
public class HomeAddress(
  public val url: String,
  token: String,
  private val http: OkHttpClient,
  private val network: LocalNetwork,
  private val clock: () -> Long = System::currentTimeMillis,
) {
  private val key = key(token)
  private val mutex = Mutex()
  private var last: Triple<Int, Outcome, Long>? = null
  private var asking: Pair<Int, CompletableDeferred<Boolean>>? = null

  internal enum class Outcome { Proven, Refused, Unanswered }

  /** Proven on the network the TV is on now: what a request checks just before it goes there, without asking. */
  public val isProven: Boolean
    get() {
      val now = network.now
      val known = last
      return now.isLocal && known != null && known.first == now.generation && known.second == Outcome.Proven
    }

  /** Whether the token may go to the home address on this network; the server there is asked the first time. */
  public suspend fun verify(): Boolean {
    val now = network.current()
    if (!now.isLocal) return false
    var mine: CompletableDeferred<Boolean>? = null
    val waiting = mutex.withLock {
      last?.let { (generation, outcome, at) -> if (generation == now.generation && holds(outcome, at)) return outcome == Outcome.Proven }
      asking?.takeIf { it.first == now.generation }?.second ?: CompletableDeferred<Boolean>().also {
        asking = now.generation to it
        mine = it
      }
    }
    mine?.let { deferred ->
      val outcome = prove()
      mutex.withLock {
        last = Triple(now.generation, outcome, clock())
        if (asking?.first == now.generation) asking = null
      }
      deferred.complete(outcome == Outcome.Proven && network.now.generation == now.generation)
    }
    return waiting.await()
  }

  private fun holds(outcome: Outcome, at: Long): Boolean = when (outcome) {
    Outcome.Proven -> true
    Outcome.Refused -> clock() < at + 600_000
    Outcome.Unanswered -> clock() < at + 30_000
  }

  /** One question to the server at `url`, and whether its answer proves it holds the session whose key this is. */
  internal suspend fun prove(): Outcome {
    val nonce = base64Url(ByteArray(32).also { SecureRandom().nextBytes(it) })
    // Without the token: the question names the session only by `id`.
    val client = ApiClient(url, http = http, timeoutMillis = 5_000)
    return try {
      val answer = client.send(Api.Auth.proof(id(nonce, key), nonce))
      if (proves(answer.proof, nonce, key)) Outcome.Proven else Outcome.Refused
    } catch (e: CancellationException) {
      throw e
    } catch (_: ApiError.Offline) {
      Outcome.Unanswered
    } catch (e: ApiError.Server) {
      if (e.status == 429 || e.status >= 500) Outcome.Unanswered else Outcome.Refused
    } catch (_: Exception) {
      Outcome.Refused
    }
  }

  internal companion object {
    const val ID_MESSAGE = "playarr-home-id:"
    const val PROOF_MESSAGE = "playarr-home-proof:"

    /** The key the server's answer is checked with: the token's SHA-256, which is what the server stores of it. */
    fun key(token: String): ByteArray = MessageDigest.getInstance("SHA-256").digest(token.toByteArray())

    fun hmac(key: ByteArray, message: String): ByteArray =
      Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }.doFinal(message.toByteArray())

    fun id(nonce: String, key: ByteArray): String = base64Url(hmac(key, ID_MESSAGE + nonce))

    /** Whether `proof` is HMAC-SHA256(key, "playarr-home-proof:" + nonce), compared in constant time. */
    fun proves(proof: String, nonce: String, key: ByteArray): Boolean {
      val mac = try { Base64.getUrlDecoder().decode(proof) } catch (_: IllegalArgumentException) { return false }
      return MessageDigest.isEqual(mac, hmac(key, PROOF_MESSAGE + nonce))
    }

    fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
  }
}
