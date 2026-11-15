package me.tracklistme.playarr.tv.playback

import android.content.ComponentName
import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.MoreExecutors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import me.tracklistme.playarr.api.Api
import me.tracklistme.playarr.api.Track
import me.tracklistme.playarr.api.TrackLevel
import me.tracklistme.playarr.player.QueueItems
import me.tracklistme.playarr.tv.playarr

/**
 * The screens' hold on the player: a MediaController connected to PlaybackService, what's playing as state, and
 * playing a list of songs, levelled with what the server knows of them (`POST /api/levels`, 50 at a time).
 */
class PlayerConnection(private val context: Context) {
  data class Now(val track: Track? = null, val playing: Boolean = false)

  private val now = MutableStateFlow(Now())
  val current: StateFlow<Now> = now.asStateFlow()
  private var controller: MediaController? = null

  init {
    val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
    val future = MediaController.Builder(context, token).buildAsync()
    future.addListener({
      val c = future.get()
      controller = c
      c.addListener(object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) = update(player)
      })
      update(c)
    }, MoreExecutors.directExecutor())
  }

  private fun update(player: Player) {
    now.value = Now(QueueItems.track(player.currentMediaItem), player.isPlaying)
  }

  /** Plays `tracks` from `start`, each at its even-volume level where the server has measured it. */
  suspend fun play(tracks: List<Track>, start: Int = 0) {
    val app = context.playarr
    val media = app.media() ?: return
    val levels = mutableMapOf<String, TrackLevel>()
    app.client()?.let { client ->
      tracks.map { it.recordingId }.distinct().chunked(50).forEach { batch ->
        runCatching { client.send(Api.Playback.levels(batch)) }.onSuccess { levels += it }
      }
    }
    val items: List<MediaItem> = QueueItems.items(tracks, levels, media)
    controller?.run {
      setMediaItems(items, start, 0)
      prepare()
      play()
    }
  }

  fun toggle() {
    controller?.run { if (isPlaying) pause() else play() }
  }

  fun next() = controller?.seekToNextMediaItem()
  fun previous() = controller?.seekToPreviousMediaItem()
}
