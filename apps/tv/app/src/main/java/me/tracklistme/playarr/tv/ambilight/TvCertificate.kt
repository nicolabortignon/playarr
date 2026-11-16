package me.tracklistme.playarr.tv.ambilight

import android.annotation.SuppressLint
import java.net.Inet4Address
import java.net.NetworkInterface
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient

/**
 * The TV's JointSpace certificate is self-signed, so no authority vouches for it. It's trusted the first time it's seen
 * (when the TV is found, before pairing) and only that certificate after: another one is refused until the TV is
 * paired again, which forgets it. Only for this TV's own addresses (`TvAddresses`).
 */
// Lint warns of any custom trust manager: this one refuses everything but the one certificate pinned, and is used only
// for the TV's own addresses.
@SuppressLint("CustomX509TrustManager")
class FirstUseTrust(private val pinned: () -> String?, private val pin: (String) -> Unit) : X509TrustManager {
  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    val leaf = chain?.firstOrNull() ?: throw CertificateException("The TV sent no certificate")
    // No date check: a TV's own certificate may carry any dates (and its clock be wrong); the pin is what's checked.
    val seen = fingerprint(leaf)
    when (val known = pinned()) {
      null -> pin(seen)
      seen -> Unit
      else -> throw CertificateException("Not the certificate this TV was paired with ($known)")
    }
  }

  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
    throw CertificateException("Playarr doesn't accept clients")

  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

  companion object {
    fun fingerprint(cert: X509Certificate): String =
      MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString(":") { "%02X".format(it) }
  }
}

/** The addresses the app reaches its own TV at: loopback first, then its network interfaces' IPv4 addresses. */
object TvAddresses {
  fun all(): List<String> {
    val own = runCatching {
      NetworkInterface.getNetworkInterfaces().toList()
        .filter { it.isUp && !it.isLoopback }
        .flatMap { it.inetAddresses.toList() }
        .filterIsInstance<Inet4Address>()
        .mapNotNull { it.hostAddress }
    }.getOrDefault(emptyList())
    return listOf("127.0.0.1") + own
  }

  /** A client for the TV's own JointSpace: its certificate pinned on first use, its names only these addresses. */
  fun client(base: OkHttpClient, trust: FirstUseTrust): OkHttpClient {
    val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
    val hosts = all().toSet()
    return base.newBuilder()
      .sslSocketFactory(tls.socketFactory, trust)
      // The certificate names the TV's model, not an address; the pin above is what identifies it.
      .hostnameVerifier(HostnameVerifier { host, _ -> host in hosts })
      .cache(null)
      .build()
  }
}
