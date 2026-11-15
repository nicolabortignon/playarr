package me.tracklistme.playarr.api

import java.net.URLEncoder
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.serializer

public enum class HttpMethod { GET, POST, PUT, PATCH, DELETE }

/** One call to the server: method, path, query and JSON body, typed by its answer (the iOS app's Endpoint). */
public class Endpoint<T>(
  public val method: HttpMethod,
  /** From the server's root, percent-encoded: "/api/albums/12". */
  public val path: String,
  public val answer: DeserializationStrategy<T>,
  public val query: List<Pair<String, String>> = emptyList(),
  /** Sent as JSON. */
  public val body: JsonElement? = null,
  /** Milliseconds before giving up; null uses the client's default. */
  public val timeoutMillis: Long? = null,
) {
  public companion object {
    /** A path segment encoded like the web's encodeURIComponent ("track:12" → "track%3A12"). */
    public fun segment(value: String): String =
      URLEncoder.encode(value, "UTF-8").replace("+", "%20").replace("%21", "!").replace("%27", "'")
        .replace("%28", "(").replace("%29", ")").replace("%7E", "~")

    /** Query pairs, leaving out the null ones. */
    public fun items(vararg pairs: Pair<String, String?>): List<Pair<String, String>> =
      pairs.mapNotNull { (name, value) -> value?.let { name to it } }

    public inline fun <reified T> get(path: String, query: List<Pair<String, String>> = emptyList(), timeoutMillis: Long? = null): Endpoint<T> =
      Endpoint(HttpMethod.GET, path, serializer<T>(), query, null, timeoutMillis)

    /** `method` with `body` written as JSON. */
    public inline fun <reified T, reified B> send(method: HttpMethod, path: String, body: B, query: List<Pair<String, String>> = emptyList(), timeoutMillis: Long? = null): Endpoint<T> =
      Endpoint(method, path, serializer<T>(), query, json(serializer<B>(), body), timeoutMillis)

    /** `method` without a body. */
    public inline fun <reified T> call(method: HttpMethod, path: String, query: List<Pair<String, String>> = emptyList(), timeoutMillis: Long? = null): Endpoint<T> =
      Endpoint(method, path, serializer<T>(), query, null, timeoutMillis)

    public fun <B> json(serializer: SerializationStrategy<B>, body: B): JsonElement = ApiJson.writing.encodeToJsonElement(serializer, body)
  }
}
