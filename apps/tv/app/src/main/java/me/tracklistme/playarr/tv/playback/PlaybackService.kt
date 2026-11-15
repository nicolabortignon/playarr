package me.tracklistme.playarr.tv.playback

import android.os.Handler
import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import me.tracklistme.playarr.api.Api
import me.tracklistme.playarr.api.PlayReport
import me.tracklistme.playarr.player.Finish
import me.tracklistme.playarr.player.PlayTracker
import me.tracklistme.playarr.player.PlayerFactory
import me.tracklistme.playarr.player.QueueItems
import me.tracklistme.playarr.tv.playarr

/**
 * The music, as a media session service (plan 9 §4): it plays on after Home, under the screensaver and with the
 * screen off, holding a foreground notification while it does so the TV doesn't reclaim it; the remote's media keys
 * and the system's Now Playing card talk to its session. Each song heard is reported to the server's history
 * (PlayTracker), sent again with the next one when the server couldn't be reached.
 */
class PlaybackService : MediaSessionService() {
  private lateinit var player: ExoPlayer
  private var session: MediaSession? = null
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private val unsent = mutableListOf<PlayReport>()
  private val tracker = PlayTracker { report -> send(report) }
  private val ticks = Handler(Looper.getMainLooper())
  private val tick = object : Runnable {
    override fun run() {
      tracker.tick(player.currentPosition / 1000.0)
      ticks.postDelayed(this, 1000)
    }
  }

  override fun onCreate() {
    super.onCreate()
    val app = playarr
    player = PlayerFactory.player(this, app.http)
    session = PlayerFactory.session(this, player, app.http)
    player.addListener(object : Player.Listener {
      override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
        tracker.finish(if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) Finish.Ended else Finish.Changed)
        QueueItems.track(item)?.let { tracker.start(it) }
      }

      override fun onIsPlayingChanged(isPlaying: Boolean) {
        ticks.removeCallbacks(tick)
        if (isPlaying) ticks.post(tick) else tracker.pause()
      }

      override fun onPositionDiscontinuity(old: Player.PositionInfo, new: Player.PositionInfo, reason: Int) {
        if (reason == Player.DISCONTINUITY_REASON_SEEK) tracker.pause()
      }

      override fun onPlaybackStateChanged(state: Int) {
        if (state == Player.STATE_ENDED) tracker.finish(Finish.Ended)
      }
    })
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  /** Sends a play, and any the server missed before. */
  private fun send(report: PlayReport) {
    unsent += report
    val batch = unsent.toList()
    val client = playarr.client() ?: return
    scope.launch {
      runCatching { client.send(Api.Playback.reportPlays(batch)) }.onSuccess { unsent.removeAll(batch) }
    }
  }

  override fun onDestroy() {
    tracker.finish(Finish.Closed)
    ticks.removeCallbacks(tick)
    session?.run {
      player.release()
      release()
    }
    session = null
    scope.cancel()
    super.onDestroy()
  }
}
