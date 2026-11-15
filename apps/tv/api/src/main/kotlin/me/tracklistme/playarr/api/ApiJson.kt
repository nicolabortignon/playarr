package me.tracklistme.playarr.api

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json

/**
 * How answers are read and bodies written, as the iOS app's JSONDecoder and JSONEncoder do: keys this version doesn't
 * know are skipped, a nullable property the server leaves out reads as null, and a body leaves out the optional
 * properties left unset (`= null`) while a property that's nullable but required goes as null, which the server reads.
 */
public object ApiJson {
  @OptIn(ExperimentalSerializationApi::class)
  public val reading: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = false
  }

  public val writing: Json = Json {
    encodeDefaults = false
    explicitNulls = true
  }
}
