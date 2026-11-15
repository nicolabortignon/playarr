package me.tracklistme.playarr.player

import me.tracklistme.playarr.api.MediaUrls
import me.tracklistme.playarr.api.Track

/**
 * Settings → Playback → Quality on the TV (plan 9 §4). High (the default) and Normal are the server's encoded stream,
 * AAC at 256 or 128 kbps, levelled by the server when even volume knows the song's gain. Original is lossless: the
 * server's levelled WAV of the song when it has a gain, else the song's own file when the TV decodes it (FLAC up to
 * 16 bits and 48 kHz, MP3, AAC), else the High stream.
 */
public enum class StreamQuality(public val kbps: Int?) {
  High(256),
  Normal(128),
  Original(null);

  /** Where the song plays from at this quality, levelled to `gain` dB when there is one. */
  public fun uri(track: Track, media: MediaUrls, gain: Double?): String {
    // Only the server's own files can be encoded or levelled (not a song streamed from elsewhere).
    if (!track.streamUrl.startsWith("/stream/")) return media.url(track.streamUrl)
    return when {
      this == Original && gain != null -> media.url("${track.streamUrl}/levelled.wav?gain=$gain")
      this == Original && tvDecodes(track) -> media.url(track.streamUrl)
      this == Original -> media.encoded(track, High.kbps!!, null)
      // A file already about this small plays as it is: encoding it again would only lose quality.
      gain == null && tvDecodes(track) && fileKbps(track) <= kbps!! * 1.25 -> media.url(track.streamUrl)
      else -> media.encoded(track, kbps!!, gain)
    }
  }

  public companion object {
    public fun of(name: String?): StreamQuality = entries.firstOrNull { it.name == name } ?: High

    /** The song's own file is one the TV's decoders play as they are. */
    public fun tvDecodes(track: Track): Boolean {
      val f = track.format
      return when (f.codec.uppercase()) {
        "MP3", "AAC" -> true
        "FLAC" -> (f.bits ?: 16) <= 16 && (f.sampleRate ?: 44_100) <= 48_000
        else -> false
      }
    }

    /** The song's own file's bitrate (kbps), as its format says or its size gives. */
    internal fun fileKbps(track: Track): Double {
      track.format.bitrate?.let { if (it > 0) return it }
      return if (track.duration > 0 && track.size > 0) track.size * 8 / track.duration / 1000 else Double.POSITIVE_INFINITY
    }
  }
}
