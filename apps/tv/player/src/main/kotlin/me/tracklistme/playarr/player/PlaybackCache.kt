package me.tracklistme.playarr.player

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import java.io.File

/**
 * The songs just played and up next, kept on the TV (plan 9 §4: no downloads, the TV is always online and its storage
 * small): 200 MB in the app's cache folder, the least recently played going first. One per process, as SimpleCache
 * allows only one per folder.
 */
@OptIn(UnstableApi::class)
public object PlaybackCache {
  public const val BYTES: Long = 200L * 1024 * 1024

  @Volatile private var cache: SimpleCache? = null

  public fun of(context: Context): SimpleCache =
    cache ?: synchronized(this) {
      cache ?: SimpleCache(File(context.cacheDir, "songs"), LeastRecentlyUsedCacheEvictor(BYTES), StandaloneDatabaseProvider(context)).also { cache = it }
    }
}
