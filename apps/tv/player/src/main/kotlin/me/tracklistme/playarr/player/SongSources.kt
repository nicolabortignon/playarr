package me.tracklistme.playarr.player

import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.exoplayer.drm.DrmSessionManagerProvider
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap

/**
 * The player's media sources: a song's encoded stream (`aac`, `levelled.aac`) as a CuttableMediaSource, so a DJ
 * transition can cut it where it joins while it plays; anything else (a song's own file, a levelled WAV, the parts of
 * a join) as Media3 makes it. The cuttable ones are kept by their item's id for `cuttable`.
 */
@OptIn(UnstableApi::class)
public class SongSources(private val data: DataSource.Factory, private var errors: LoadErrorHandlingPolicy, private val default: DefaultMediaSourceFactory) : MediaSource.Factory {
  private val made = ConcurrentHashMap<String, WeakReference<CuttableMediaSource>>()

  /** The cuttable source made for the queue entry `mediaId`, while the player holds it. */
  public fun cuttable(mediaId: String): CuttableMediaSource? = made[mediaId]?.get()

  override fun createMediaSource(mediaItem: MediaItem): MediaSource {
    if (!QueueItems.isEncodedSong(mediaItem)) return default.createMediaSource(mediaItem)
    made.values.removeIf { it.get() == null }
    return CuttableMediaSource.of(mediaItem, data, errors).also { made[mediaItem.mediaId] = WeakReference(it) }
  }

  override fun setDrmSessionManagerProvider(drmSessionManagerProvider: DrmSessionManagerProvider): MediaSource.Factory = apply {
    default.setDrmSessionManagerProvider(drmSessionManagerProvider)
  }

  override fun setLoadErrorHandlingPolicy(loadErrorHandlingPolicy: LoadErrorHandlingPolicy): MediaSource.Factory = apply {
    errors = loadErrorHandlingPolicy
    default.setLoadErrorHandlingPolicy(loadErrorHandlingPolicy)
  }

  override fun getSupportedTypes(): IntArray = default.supportedTypes
}
