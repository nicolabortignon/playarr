package me.tracklistme.playarr.tv.playback

import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import me.tracklistme.playarr.api.Api
import me.tracklistme.playarr.api.PlayReport
import me.tracklistme.playarr.player.Finish
import me.tracklistme.playarr.player.PlayTracker
import me.tracklistme.playarr.player.PlaybackCache
import me.tracklistme.playarr.player.PlayerFactory
import me.tracklistme.playarr.player.QueueItems
import me.tracklistme.playarr.player.Radio
import me.tracklistme.playarr.player.StreamQuality
import me.tracklistme.playarr.tv.playarr

/**
 * The music, as a media session service (plan 9 §4): it plays on after Home, under the screensaver and with the
 * screen off, holding a foreground notification while it does so the TV doesn't reclaim it; the remote's media keys
 * and the system's Now Playing card talk to its session. Around the player:
 *
 * - each song heard is reported to the server's history (PlayTracker) unless this TV doesn't count, sent again with the
 *   next one when the server couldn't be reached;
 * - the queue's last song asks for more like it (Radio), when "Keep playing" is on;
 * - the sleep timer fades the music out and pauses it, or pauses at the end of the song;
 * - a dead spot (the network or the server gone a moment) is ridden out: the song is asked for again where it stopped,
 *   after 2 s, then longer, up to every 30 s; a stream the server refuses falls back to another form of the song
 *   (the plain encoded stream, then its own file), and a song nothing plays is skipped.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
  private lateinit var player: ExoPlayer
  private var session: MediaSession? = null
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private val unsent = mutableListOf<PlayReport>()
  private val tracker = PlayTracker { report -> send(report) }
  private val main = Handler(Looper.getMainLooper())
  private var retries = 0
  private val retry = Runnable { player.prepare() }
  /** Streams the server refused this session, so a fallback never goes back to one. */
  private val refused = mutableSetOf<String>()
  private var radioAskedAt: String? = null
  private val tick = object : Runnable {
    override fun run() {
      tracker.tick(player.currentPosition / 1000.0)
      sleepTick()
      main.postDelayed(this, TICK_MS)
    }
  }

  override fun onCreate() {
    super.onCreate()
    val app = playarr
    player = PlayerFactory.player(this, app.songHttp, PlaybackCache.of(this))
    session = PlayerFactory.session(this, player, app.http)
    player.addListener(object : Player.Listener {
      override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
        tracker.finish(if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) Finish.Ended else Finish.Changed)
        QueueItems.track(item)?.let { tracker.start(it) }
        continueRadio()
      }

      override fun onIsPlayingChanged(isPlaying: Boolean) {
        main.removeCallbacks(tick)
        if (isPlaying) main.post(tick) else tracker.pause()
      }

      override fun onPositionDiscontinuity(old: Player.PositionInfo, new: Player.PositionInfo, reason: Int) {
        if (reason == Player.DISCONTINUITY_REASON_SEEK) tracker.pause()
      }

      override fun onPlaybackStateChanged(state: Int) {
        if (state == Player.STATE_READY) retries = 0
        if (state == Player.STATE_ENDED) tracker.finish(Finish.Ended)
      }

      override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        // The sleep timer waited for this song's end.
        if (reason == Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM) app.sleep.cancel()
      }

      override fun onPlayerError(error: PlaybackException) = recover(error)
    })
    app.sleep.current.onEach { state ->
      player.pauseAtEndOfMediaItems = state.endOfSong
      if (state.endsAt == null) player.volume = 1f
    }.launchIn(scope)
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  /** Sends a play, and any the server missed before; nothing when this TV doesn't count towards history. */
  private fun send(report: PlayReport) {
    if (!playarr.playback.now.recordPlays) return
    unsent += report
    val batch = unsent.toList()
    val client = playarr.client() ?: return
    scope.launch {
      runCatching { client.send(Api.Playback.reportPlays(batch)) }.onSuccess { unsent.removeAll(batch) }
    }
  }

  /** As the queue's last song starts: songs like the last few, added after it (once per song). */
  private fun continueRadio() {
    val index = player.currentMediaItemIndex
    val key = "$index:${player.currentMediaItem?.mediaId}"
    if (key == radioAskedAt) return
    radioAskedAt = key
    val queue = (0 until player.mediaItemCount).mapNotNull { QueueItems.track(player.getMediaItemAt(it)) }
    val ask = Radio.continuation(
      played = queue.take(index + 1),
      queue = queue,
      last = !player.hasNextMediaItem(),
      repeating = player.repeatMode != Player.REPEAT_MODE_OFF,
      autoplay = playarr.playback.now.autoplay,
    ) ?: return
    val client = playarr.client() ?: return
    scope.launch {
      val more = runCatching { client.send(Api.Playback.radio(ask.seeds, ask.exclude, Radio.COUNT)) }.getOrNull().orEmpty()
      val current = QueueItems.track(player.currentMediaItem)
      // Still on that last song, nothing queued meanwhile: carry on with these.
      if (more.isEmpty() || current == null || player.currentMediaItemIndex != index || player.hasNextMediaItem()) return@launch
      player.addMediaItems(Songs(playarr).items(listOf(current) + more, from = 1))
    }
  }

  private fun sleepTick() {
    val sleep = playarr.sleep
    if (sleep.current.value.endsAt == null) return
    if (sleep.runsOut()) {
      player.pause()
      player.volume = 1f
    } else {
      player.volume = sleep.volume()
    }
  }

  /** After an error: wait out a dead spot, fall back from a stream the server refuses, skip what can't be played. */
  private fun recover(error: PlaybackException) {
    val status = (error.cause as? HttpDataSource.InvalidResponseCodeException)?.responseCode
    val network = error.errorCode in NETWORK_ERRORS || (status != null && status >= 500)
    if (network) {
      val delay = BACKOFF_SECONDS[minOf(retries, BACKOFF_SECONDS.lastIndex)]
      retries++
      main.removeCallbacks(retry)
      main.postDelayed(retry, delay * 1000L)
      return
    }
    val index = player.currentMediaItemIndex
    val item = player.currentMediaItem
    val track = QueueItems.track(item)
    val media = playarr.media()
    val uri = item?.localConfiguration?.uri?.toString()
    if (track != null && media != null && uri != null && status != null) {
      refused += uri
      val other = listOfNotNull(
        media.encoded(track, StreamQuality.High.kbps!!, null),
        media.url(track.streamUrl).takeIf { StreamQuality.tvDecodes(track) },
      ).firstOrNull { it !in refused }
      if (other != null) {
        player.replaceMediaItem(index, QueueItems.item(track, other, media))
        player.prepare()
        return
      }
    }
    // Nothing else to try for this song: the next one.
    if (player.hasNextMediaItem()) {
      player.seekToNextMediaItem()
      player.prepare()
    }
  }

  override fun onDestroy() {
    tracker.finish(Finish.Closed)
    main.removeCallbacksAndMessages(null)
    session?.run {
      player.release()
      release()
    }
    session = null
    scope.cancel()
    super.onDestroy()
  }

  private companion object {
    const val TICK_MS = 500L
    val BACKOFF_SECONDS = listOf(2, 4, 8, 15, 30)
    val NETWORK_ERRORS = setOf(
      PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
      PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
      PlaybackException.ERROR_CODE_IO_UNSPECIFIED,
      PlaybackException.ERROR_CODE_TIMEOUT,
    )
  }
}
