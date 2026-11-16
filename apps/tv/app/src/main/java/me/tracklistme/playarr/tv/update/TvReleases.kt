package me.tracklistme.playarr.tv.update

import java.io.IOException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * The TV app's releases on GitHub (plan 9 §7). CI puts each `tv-v<version>` tag's sideload APK,
 * `playarr-tv-<version>.apk`, on a release of its own, not marked latest (the server's releases are), so finding the
 * newest takes two small requests: the repository's `tv-v*` tags, then the release of the highest tag newer than this
 * app. A tag whose release isn't there yet (CI still building it) gives way to the one below it.
 *
 * [repo] is the repository's API address, `https://api.github.com/repos/<owner>/<name>`.
 */
class TvReleases(private val http: OkHttpClient, private val repo: String) {
  data class Release(
    val version: String,
    /** The APK's download address. */
    val apk: String,
    val size: Long,
    /** The APK's SHA-256 in hex, from GitHub's asset digest; null on a release from before GitHub gave them. */
    val sha256: String?,
    val notes: String,
  )

  /** The newest release newer than [installed], or null when there's none. Throws IOException when GitHub can't say. */
  fun newest(installed: String): Release? {
    val current = Version.parse(installed) ?: Version(emptyList())
    val tags = get("$repo/git/matching-refs/tags/$TAG")?.jsonArray.orEmpty()
      .mapNotNull { it.jsonObject["ref"]?.jsonPrimitive?.contentOrNull?.removePrefix("refs/tags/") }
      .mapNotNull { tag -> Version.parse(tag.removePrefix(TAG))?.let { it to tag } }
      .filter { (version) -> version > current }
      .sortedByDescending { (version) -> version }
    for ((_, tag) in tags.take(TRIES)) {
      val release = get("$repo/releases/tags/$tag")?.jsonObject ?: continue
      return of(release, tag.removePrefix(TAG)) ?: continue
    }
    return null
  }

  /** The answer's JSON, or null for a 404. */
  private fun get(url: String): JsonElement? {
    val request = Request.Builder().url(url)
      .header("Accept", "application/vnd.github+json")
      .header("X-GitHub-Api-Version", "2022-11-28")
      .build()
    http.newCall(request).execute().use { response ->
      if (response.code == 404) return null
      if (!response.isSuccessful) {
        val limited = response.code == 403 || response.code == 429
        throw IOException(if (limited) "GitHub asks to wait before looking again (${response.code})" else "GitHub answered ${response.code}")
      }
      return Json.parseToJsonElement(response.body.string())
    }
  }

  companion object {
    const val TAG = "tv-v"
    /** How many tags newer than this app to try, newest first, before saying there's nothing. */
    private const val TRIES = 3

    /** The APK on a release, or null when it's a draft, a pre-release or has no `playarr-tv-<version>.apk` yet. */
    fun of(release: JsonObject, version: String): Release? {
      if (release["draft"]?.jsonPrimitive?.booleanOrNull == true) return null
      if (release["prerelease"]?.jsonPrimitive?.booleanOrNull == true) return null
      val name = "playarr-tv-$version.apk"
      val asset = (release["assets"] as? JsonArray).orEmpty().map { it.jsonObject }.firstOrNull { asset ->
        asset["name"]?.jsonPrimitive?.contentOrNull == name && asset["state"]?.jsonPrimitive?.contentOrNull.let { it == null || it == "uploaded" }
      } ?: return null
      val url = asset["browser_download_url"]?.jsonPrimitive?.contentOrNull ?: return null
      val size = asset["size"]?.jsonPrimitive?.longOrNull ?: return null
      val digest = asset["digest"]?.jsonPrimitive?.contentOrNull
      val sha256 = digest?.takeIf { it.startsWith("sha256:") }?.removePrefix("sha256:")?.lowercase()?.takeIf { HEX.matches(it) }
      val notes = release["body"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
      return Release(version, url, size, sha256, notes)
    }

    private val HEX = Regex("[0-9a-f]{64}")
  }
}

/** A version name of numbers between dots, `1.2.0`, compared number by number (1.10 is after 1.9). */
data class Version(val parts: List<Int>) : Comparable<Version> {
  override fun compareTo(other: Version): Int {
    for (i in 0 until maxOf(parts.size, other.parts.size)) {
      val c = parts.getOrElse(i) { 0 }.compareTo(other.parts.getOrElse(i) { 0 })
      if (c != 0) return c
    }
    return 0
  }

  override fun toString() = parts.joinToString(".")

  companion object {
    fun parse(text: String): Version? {
      val parts = text.trim().split('.').map { it.toIntOrNull() ?: return null }
      return parts.takeIf { it.isNotEmpty() && it.all { p -> p >= 0 } }?.let(::Version)
    }
  }
}
