package me.tracklistme.playarr.tv.playback

import android.content.ComponentName
import android.content.Context
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.MoreExecutors
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withTimeoutOrNull
import me.tracklistme.playarr.api.Track
import me.tracklistme.playarr.player.QueueItems
import me.tracklistme.playarr.tv.playarr

/**
 * The screens' hold on the player: a MediaController connected to PlaybackService, what's playing as state, and
 * playing a list of songs (Songs: at the quality and level the settings ask for).
 */
class PlayerConnection(private val context: Context) {
  /**
   * What's playing: the song (a DJ transition shows the song coming in), whether it plays, and the songs up next (a
   * join's parts once). `positionMs` and `durationMs` are as of the last change: `position()` is the live one.
   */
  data class Now(
    val track: Track? = null,
    val playing: Boolean = false,
    val upNext: List<Track> = emptyList(),
    val hasPrevious: Boolean = false,
    val hasNext: Boolean = false,
    val durationMs: Long = 0,
  )

  private val now = MutableStateFlow(Now())
  val current: StateFlow<Now> = now.asStateFlow()
  private var controller: MediaController? = null
  private val connected = CompletableDeferred<MediaController>()

  init {
    val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
    val future = MediaController.Builder(context, token).buildAsync()
    future.addListener({
      val c = runCatching { future.get() }.getOrElse { return@addListener }
      controller = c
      connected.complete(c)
      c.addListener(object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) = update(player)
      })
      update(c)
    }, MoreExecutors.directExecutor())
  }

  private fun update(player: Player) {
    val index = player.currentMediaItemIndex
    val upNext = if (index == C.INDEX_UNSET) emptyList() else
      (index + 1 until minOf(player.mediaItemCount, index + 1 + UP_NEXT))
        .map { player.getMediaItemAt(it) }
        .filter { QueueItems.part(it) == QueueItems.Part.Song }
        .mapNotNull { QueueItems.track(it) }
    now.value = Now(
      track = QueueItems.track(player.currentMediaItem),
      playing = player.isPlaying,
      upNext = upNext,
      hasPrevious = player.hasPreviousMediaItem(),
      hasNext = player.hasNextMediaItem(),
      durationMs = player.duration.takeIf { it != C.TIME_UNSET } ?: 0,
    )
  }

  /** Where the song is now (ms). */
  fun position(): Long = controller?.currentPosition ?: 0

  /** Plays `tracks` from `start`, each at its even-volume level where the server has measured it. */
  suspend fun play(tracks: List<Track>, start: Int = 0) {
    val items = Songs(context.playarr).items(tracks)
    if (items.isEmpty()) return
    // Just after the app starts the controller may still be connecting: OK on Play waits for it.
    val c = withTimeoutOrNull(CONNECT_WAIT_MS) { connected.await() } ?: return
    c.run {
      shuffleModeEnabled = false
      setMediaItems(items, start.coerceIn(0, items.lastIndex), 0)
      prepare()
      play()
    }
  }

  /** Plays `tracks` in an order of their own. */
  suspend fun shuffle(tracks: List<Track>) = play(tracks.shuffled())

  fun toggle() {
    controller?.run { if (isPlaying) pause() else play() }
  }

  fun next() = controller?.seekToNextMediaItem()
  fun previous() = controller?.seekToPrevious()
  fun seekBy(ms: Long) = controller?.run { seekTo((currentPosition + ms).coerceIn(0, duration.takeIf { it != C.TIME_UNSET } ?: Long.MAX_VALUE)) }

  private companion object {
    const val UP_NEXT = 30
    const val CONNECT_WAIT_MS = 10_000L
  }
}
