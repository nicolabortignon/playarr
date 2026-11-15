package me.tracklistme.playarr.api

import java.net.URI

/**
 * Addresses of a server's songs, transitions and images (the iOS app's MediaURLs). The token never goes in a URL:
 * `headers(url)` gives the Authorization header, only for this server (or its home address once proven).
 */
public class MediaUrls(public val baseUrl: String, public val home: HomeAddress? = null, private val token: String?) {
  /** A path the server gave (`Track.streamUrl`, `coverUrl`, a transition's `url`) on this server; absolute URLs as they are. */
  public fun url(path: String): String {
    if (path.startsWith("http://") || path.startsWith("https://")) return path
    return baseUrl.trimEnd('/') + path
  }

  /** GET /stream/:fileId: the song's own file, with Range support. */
  public fun stream(fileId: Int): String = url("/stream/$fileId")

  /**
   * The song encoded by the server as AAC at `kbps` (128 or 256) in fragmented MP4, levelled to `gain` dB when given
   * (even volume): what the TV plays by default (plan 9 §4; docs/server/streaming-and-art.md §2).
   */
  public fun encoded(track: Track, kbps: Int, gain: Double? = null): String {
    val query = "kbps=$kbps" + (gain?.let { "&gain=$it" } ?: "")
    return url("${track.streamUrl}/${if (gain != null) "levelled.aac" else "aac"}?$query")
  }

  /** A rendered transition: the `url` of a ready `TransitionAnswer` (or its `continuationUrl`). */
  public fun transition(path: String): String = url(path)

  /** A cover or artist image resized by the server to `size` pixels (the longest side). */
  public fun art(path: String?, size: Int): String? {
    if (path == null) return null
    val base = url(path)
    return base + (if (base.contains('?')) "&" else "?") + "size=$size"
  }

  /** The Authorization header for `url` when it's on this server, or at its home address while that's proven. */
  public fun headers(url: String): Map<String, String> =
    if (token != null && mayCarryToken(url)) mapOf("Authorization" to "Bearer $token") else emptyMap()

  /** `url` (one of these addresses) at the server's home address; null without one, or for a URL elsewhere. */
  public fun onLocalAddress(url: String): String? {
    val local = home?.url ?: return null
    if (!sameOrigin(url, baseUrl)) return null
    val basePath = path(baseUrl).trimEnd('/')
    val target = URI(url)
    val rawPath = target.rawPath ?: ""
    if (!rawPath.startsWith(basePath)) return null
    val query = target.rawQuery?.let { "?$it" } ?: ""
    return local.trimEnd('/') + rawPath.removePrefix(basePath) + query
  }

  private fun mayCarryToken(url: String): Boolean {
    if (sameOrigin(url, baseUrl)) return true
    val home = home ?: return false
    return sameOrigin(url, home.url) && home.isProven
  }

  internal companion object {
    fun sameOrigin(a: String, b: String): Boolean = try {
      val x = URI(a)
      val y = URI(b)
      x.scheme == y.scheme && x.host == y.host && port(x) == port(y)
    } catch (_: Exception) {
      false
    }

    private fun port(uri: URI) = if (uri.port >= 0) uri.port else if (uri.scheme == "https") 443 else 80
    private fun path(url: String) = URI(url).rawPath ?: ""
  }
}
