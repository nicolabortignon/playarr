package me.tracklistme.playarr.player

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.session.MediaSession
import okhttp3.OkHttpClient

/**
 * The TV's player: ExoPlayer reading the server's streams through the app's OkHttp client (which puts the token on the
 * server's media requests), holding audio focus as music, pausing when the output goes, keeping Wi-Fi awake while it
 * plays, and waiting out a busy server (503 with Retry-After, too many encodes at once) as the iOS app does.
 */
@OptIn(UnstableApi::class)
public object PlayerFactory {
  public fun player(context: Context, http: OkHttpClient): ExoPlayer {
    val sources = DefaultMediaSourceFactory(context)
      .setDataSourceFactory(OkHttpDataSource.Factory(http))
      .setLoadErrorHandlingPolicy(BusyServer())
    return ExoPlayer.Builder(context)
      .setMediaSourceFactory(sources)
      .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()
  }

  /** The session the system's Now Playing card and the remote's media keys talk to; covers load with the token. */
  public fun session(context: Context, player: ExoPlayer, http: OkHttpClient): MediaSession =
    MediaSession.Builder(context, player)
      .setBitmapLoader(DataSourceBitmapLoader.Builder(context).setDataSourceFactory(OkHttpDataSource.Factory(http)).setMaximumOutputDimension(512).build())
      .build()

  /** A 503 is the server saying "busy, ask again in a moment": wait what it says (2 s if it doesn't) and try again. */
  private class BusyServer : DefaultLoadErrorHandlingPolicy() {
    override fun getRetryDelayMsFor(info: LoadErrorHandlingPolicy.LoadErrorInfo): Long {
      val busy = info.exception as? HttpDataSource.InvalidResponseCodeException
      if (busy?.responseCode == 503 && info.errorCount <= BUSY_TRIES) {
        val seconds = busy.headerFields["Retry-After"]?.firstOrNull()?.trim()?.toLongOrNull() ?: 2
        return seconds.coerceIn(1, 30) * 1000
      }
      return super.getRetryDelayMsFor(info)
    }

    override fun getMinimumLoadableRetryCount(dataType: Int): Int = BUSY_TRIES
  }

  private const val BUSY_TRIES = 10
}
