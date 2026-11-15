package me.tracklistme.playarr.api

import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The generated Kotlin models read and write as the Swift ones do (apps/ios GeneratedModelsTests.swift). */
class GeneratedModelsTests {
  private inline fun <reified T> decode(text: String): T = ApiJson.reading.decodeFromString(text)
  private inline fun <reified T> objectOf(value: T): JsonObject = ApiJson.writing.encodeToJsonElement(kotlinx.serialization.serializer<T>(), value).jsonObject

  @Test fun readsAnUnknownEnumValueWithoutFailing() {
    val availability = decode<Availability>("""{"state":"teleporting"}""")
    assertEquals("teleporting", availability.state.value)
    assertFalse(availability.state.isKnown)
    assertEquals(AvailabilityState.None, decode<Availability>("""{"state":"none"}""").state)
  }

  @Test fun readsEachTransitionAnswer() {
    val unavailable = decode<TransitionAnswer>("""{"status":"unavailable","reason":"No mix map yet"}""")
    assertEquals(TransitionAnswer.Unavailable(reason = "No mix map yet"), unavailable)
    assertEquals(TransitionAnswer.Unknown("exploded"), decode<TransitionAnswer>("""{"status":"exploded"}"""))
  }

  @Test fun writesTheTagBack() {
    val sent = ApiJson.writing.encodeToJsonElement(TransitionAnswer.serializer(), TransitionAnswer.Unavailable(reason = "off")).jsonObject
    assertEquals("unavailable", sent["status"]?.jsonPrimitive?.content)
    assertEquals("off", sent["reason"]?.jsonPrimitive?.content)
  }

  @Test fun readsTheOtherUnion() {
    assertTrue(decode<RematchResult>("""{"kind":"lidarr","message":"Refreshing"}""") is RematchResult.Lidarr)
  }

  @Test fun sendsARequiredNullAsNullAndLeavesOutWhatIsntSet() {
    val account = decode<Account>("""{"id":1,"username":"owner","name":"Home","role":"admin","canRequest":true,"sources":null,"hasPassword":true}""")
    assertEquals(AccountRole.Admin, account.role)
    val sent = objectOf(account)
    assertEquals(JsonNull, sent["sources"])
    assertFalse("requestAccess" in sent)
  }

  @Test fun readsADictionary() {
    val levels = ApiJson.reading.decodeFromString(MapSerializer(String.serializer(), TrackLevel.serializer()), """{"rec-1":{"track":-6.1,"album":-4.2}}""")
    assertEquals(-4.2, levels["rec-1"]?.album)
  }
}
