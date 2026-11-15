package me.tracklistme.playarr.api

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder

/** An answer with no body (204), or one the caller doesn't need. */
@Serializable(with = NoContent.Reader::class)
public data object NoContent {
  internal object Reader : KSerializer<NoContent> {
    override val descriptor: SerialDescriptor = SerialDescriptor("NoContent", kotlinx.serialization.json.JsonElement.serializer().descriptor)
    override fun deserialize(decoder: Decoder): NoContent {
      (decoder as? JsonDecoder)?.decodeJsonElement()
      return NoContent
    }
    override fun serialize(encoder: Encoder, value: NoContent): Unit = throw UnsupportedOperationException("NoContent is never sent")
  }
}

/**
 * GET /api/albums with `offset`: a page of the albums (plan 3 §1), or, from a server older than pages (before 0.6.564,
 * which leaves `offset` out), all of them at once. Either way, a page: the whole list is one page holding every album.
 */
@Serializable(with = AlbumsAnswer.Reader::class)
public data class AlbumsAnswer(val page: AlbumPage) {
  internal object Reader : KSerializer<AlbumsAnswer> {
    override val descriptor: SerialDescriptor = AlbumPage.serializer().descriptor
    override fun deserialize(decoder: Decoder): AlbumsAnswer {
      val json = decoder as JsonDecoder
      val element = json.decodeJsonElement()
      if (element is JsonArray) {
        val albums = json.json.decodeFromJsonElement(ListSerializer(Album.serializer()), element)
        return AlbumsAnswer(AlbumPage(albums = albums, total = albums.size, version = ""))
      }
      return AlbumsAnswer(json.json.decodeFromJsonElement(AlbumPage.serializer(), element))
    }
    override fun serialize(encoder: Encoder, value: AlbumsAnswer): Unit = AlbumPage.serializer().serialize(encoder, value.page)
  }
}

/** POST /api/plays. */
@Serializable public data class Recorded(val recorded: Int)

/**
 * POST /api/playlists/holding: how many of the songs asked about each of the account's own playlists holds, by playlist
 * id (a JSON object's keys are strings). Playlists holding none are left out.
 */
@Serializable
public data class PlaylistsHolding(val holding: Map<String, Int>) {
  /** How many of the songs the playlist `id` holds: 0 when it holds none. */
  public fun count(id: Int): Int = holding[id.toString()] ?: 0
}

/** GET /api/tracks/:id/lyrics: null when none were found. */
@Serializable public data class LyricsAnswer(val lyrics: Lyrics? = null)

/** How this device names itself to the server's session list (Settings → Accounts): platform "tv". */
public data class DeviceInfo(val name: String, val platform: String = "tv")
