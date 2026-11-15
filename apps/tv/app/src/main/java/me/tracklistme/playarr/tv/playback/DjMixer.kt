package me.tracklistme.playarr.tv.playback

import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import me.tracklistme.playarr.api.Api
import me.tracklistme.playarr.api.ApiError
import me.tracklistme.playarr.api.TransitionAnswer
import me.tracklistme.playarr.player.Joins
import me.tracklistme.playarr.player.JoinRules
import me.tracklistme.playarr.player.QueueItems
import me.tracklistme.playarr.player.QueueItems.Part
import me.tracklistme.playarr.player.SongSources
import me.tracklistme.playarr.player.TransitionAsker
import me.tracklistme.playarr.tv.PlayarrApp

/**
 * DJ mix on the TV (plan 9 §4). While a song plays, with Settings → Playback → Transitions on DJ mix, the transition
 * into the next is asked for (TransitionAsker); once it's ready, in time, the queue is joined (Joins): the song is cut
 * where the transition takes over, the transition is put after it, and the next song plays on from where the
 * transition ends. Songs the server says go straight on (an album in order), or that it can't mix, follow gapless.
 *
 * Only whole songs as encoded streams, in order (not shuffled), are joined. Skipping into a joined part plays the
 * next song whole again, from its start, and the song before keeps its own end.
 */
@OptIn(UnstableApi::class)
class DjMixer(private val app: PlayarrApp, private val player: ExoPlayer, private val sources: SongSources, scope: CoroutineScope) {
  private val asker = TransitionAsker(SystemClock::elapsedRealtime) { request, done ->
    val client = app.client()
    if (client == null) done(Result.failure(ApiError.Offline)) else scope.launch { done(runCatching { client.send(Api.Playback.transition(request)) }) }
  }

  init {
    asker.onReady = ::join
  }

  /** On every tick while playing. */
  fun tick() {
    asker.tick(wanted(), player.currentPosition / 1000.0)
  }

  /** The pair to mix now: the song playing into the next, when both can be joined. */
  private fun wanted(): TransitionAsker.Pair? {
    if (app.playback.now.transitions != PlaybackSettings.Transitions.Dj || player.shuffleModeEnabled) return null
    val i = player.currentMediaItemIndex
    if (i == C.INDEX_UNSET || player.nextMediaItemIndex != i + 1) return null
    val a = player.getMediaItemAt(i)
    val b = player.getMediaItemAt(i + 1)
    if (!QueueItems.isEncodedSong(a) || !QueueItems.isEncodedSong(b)) return null
    // Already cut: joined, or being joined.
    if (sources.cuttable(a.mediaId)?.endUs != C.TIME_END_OF_SOURCE) return null
    val from = QueueItems.track(a) ?: return null
    val to = QueueItems.track(b) ?: return null
    return TransitionAsker.Pair(
      key = "${a.mediaId}>${b.mediaId}",
      from = from,
      to = to,
      albumQueue = JoinRules.continues(from, to),
      // The levels each stream plays at (0 dB for one that isn't levelled): the transition is made at them.
      levels = TransitionAnswer.Ready.Levels(QueueItems.gain(a) ?: 0.0, QueueItems.gain(b) ?: 0.0),
    )
  }

  private fun join(pair: TransitionAsker.Pair, ready: TransitionAnswer.Ready) {
    val i = player.currentMediaItemIndex
    if (i == C.INDEX_UNSET || i + 1 >= player.mediaItemCount) return
    val a = player.getMediaItemAt(i)
    val b = player.getMediaItemAt(i + 1)
    // The queue changed meanwhile.
    if ("${a.mediaId}>${b.mediaId}" != pair.key) return
    val source = sources.cuttable(a.mediaId) ?: return
    val join = Joins.of(ready, source.trimmed ?: return) ?: return
    // Too close to the cut to place it before the player reads past it.
    if (player.currentPosition / 1000.0 > join.endSeconds - APPLY_MARGIN_SECONDS) return
    val media = app.media() ?: return
    val gain = QueueItems.gain(b)
    val transition = QueueItems.item(pair.to, media.transitionAac(ready.url, QueueItems.kbps(a), join.transitionStart), media, gain, Part.Transition)
    val rest = QueueItems.item(pair.to, media.encoded(pair.to, QueueItems.kbps(b), gain, join.bStart), media, gain, Part.Rest)
    player.createMessage { _, _ -> source.cut(join.cutUs) }.setLooper(player.playbackLooper).send()
    player.replaceMediaItem(i + 1, rest)
    player.addMediaItem(i + 1, transition)
  }

  /**
   * A song changed. Skipping into a joined part (not the music going on by itself) plays the next song whole from its
   * start instead, and the song before it plays to its own end again.
   */
  fun changed(item: MediaItem?, reason: Int) {
    if (item == null || reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO || reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT) return
    val part = QueueItems.part(item)
    if (part == Part.Song) return
    val track = QueueItems.track(item) ?: return
    val media = app.media() ?: return
    var i = player.currentMediaItemIndex
    val whole = QueueItems.item(track, media.encoded(track, QueueItems.kbps(item), QueueItems.gain(item)), media, QueueItems.gain(item))
    if (part == Part.Transition && i + 1 < player.mediaItemCount && QueueItems.part(player.getMediaItemAt(i + 1)) == Part.Rest) player.removeMediaItem(i + 1)
    if (part == Part.Rest && i > 0 && QueueItems.part(player.getMediaItemAt(i - 1)) == Part.Transition) {
      player.removeMediaItem(i - 1)
      i -= 1
    }
    // The song before, cut for the join, gets its end back.
    if (i > 0) sources.cuttable(player.getMediaItemAt(i - 1).mediaId)?.let { s -> player.createMessage { _, _ -> s.cut(C.TIME_END_OF_SOURCE) }.setLooper(player.playbackLooper).send() }
    player.replaceMediaItem(i, whole)
    player.seekTo(i, 0)
  }

  private companion object {
    /** Seconds before A's cut a join must be placed by: the player reads a little ahead of what it plays. */
    const val APPLY_MARGIN_SECONDS = 3.0
  }
}
