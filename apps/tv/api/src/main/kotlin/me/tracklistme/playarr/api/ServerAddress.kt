package me.tracklistme.playarr.api

import java.net.URI

/**
 * Turns what someone typed into a server's base URL (the iOS app's ServerAddress). Plain HTTP is only for the home
 * network; everything else is HTTPS.
 */
public object ServerAddress {
  public enum class Problem(public val message: String) {
    Empty("Enter the server’s address."),
    Invalid("That isn’t a web address."),
    NeedsHttps("Use https:// for a server outside your home network."),
  }

  public class Rejected(public val problem: Problem) : Exception(problem.message)

  /** The base URL, without a trailing slash, query or fragment. */
  public fun url(from: String): String {
    var text = from.trim()
    if (text.isEmpty()) throw Rejected(Problem.Empty)
    if (!text.contains("://")) {
      val host = text.split("/").first()
      text = (if (isLocal(hostOnly(host))) "http://" else "https://") + text
    }
    val uri = try { URI(text) } catch (_: Exception) { throw Rejected(Problem.Invalid) }
    val scheme = uri.scheme?.lowercase()
    val host = uri.host
    if ((scheme != "http" && scheme != "https") || host.isNullOrEmpty()) throw Rejected(Problem.Invalid)
    if (scheme == "http" && !isLocal(host)) throw Rejected(Problem.NeedsHttps)
    val path = (uri.rawPath ?: "").trimEnd('/')
    val port = if (uri.port >= 0) ":${uri.port}" else ""
    return "$scheme://$host$port$path"
  }

  /** localhost, single-label and .local names, and private, loopback and link-local addresses. */
  public fun isLocal(host: String): Boolean {
    val name = host.lowercase().trim('[', ']')
    if (name == "localhost" || name.endsWith(".local")) return true
    val octets = name.split(".").mapNotNull { it.toIntOrNull()?.takeIf { n -> n in 0..255 } }
    if (octets.size == 4 && name.split(".").size == 4) {
      val (a, b) = octets
      return a == 10 || a == 127 || (a == 192 && b == 168) || (a == 169 && b == 254) || (a == 172 && b in 16..31)
    }
    if (name.contains(":")) return name == "::1" || name.startsWith("fe80:") || name.startsWith("fc") || name.startsWith("fd")
    return !name.contains(".")
  }

  private fun hostOnly(hostAndPort: String): String =
    if (hostAndPort.startsWith("[")) hostAndPort.drop(1).takeWhile { it != ']' } else hostAndPort.takeWhile { it != ':' }
}
