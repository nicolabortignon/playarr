package me.tracklistme.playarr.tv.ui.nowplaying

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.foundation.focusable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.tv.material3.Icon
import androidx.tv.material3.IconButton
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import me.tracklistme.playarr.api.Api
import me.tracklistme.playarr.api.Lyrics
import me.tracklistme.playarr.api.Track
import me.tracklistme.playarr.tv.playarr
import me.tracklistme.playarr.tv.ui.common.Art
import me.tracklistme.playarr.tv.ui.common.Load
import me.tracklistme.playarr.tv.ui.common.Margins
import me.tracklistme.playarr.tv.ui.common.TvIcons
import me.tracklistme.playarr.tv.ui.common.duration
import me.tracklistme.playarr.tv.ui.common.hexColor
import me.tracklistme.playarr.tv.ui.common.rememberLoad
import me.tracklistme.playarr.tv.ui.shell.LocalImmersive
import me.tracklistme.playarr.tv.ui.theme.Palette
import me.tracklistme.playarr.tv.ui.theme.Type

/** After this long without a key, Now Playing turns to its art mode (plan 9 §5, OLED care). */
private const val ART_MODE_AFTER_MS = 60_000L

/**
 * Now Playing (plan 9 §5): the cover large on the cover's own accent, the song, where it is, the transport, and the
 * synced lyrics (or what's up next). The screen most often left up: after a minute without a key it becomes art
 * mode (the cover drifting slowly, the text dimmed, nothing white standing still), and the TV's own screensaver
 * turns it black after that. Any key brings the controls back.
 */
@Composable
fun NowPlayingScreen() {
  val app = LocalContext.current.playarr
  val now by app.player.current.collectAsStateWithLifecycle()
  var lastKey by remember { mutableLongStateOf(System.currentTimeMillis()) }
  var artMode by remember { mutableStateOf(false) }
  var position by remember { mutableLongStateOf(0L) }
  LaunchedEffect(Unit) {
    while (true) {
      position = app.player.position()
      val idle = System.currentTimeMillis() - lastKey >= ART_MODE_AFTER_MS
      artMode = now.track != null && (artMode || idle)
      delay(500)
    }
  }
  // In art mode the page holds the focus itself (the controls are gone; the rail mustn't take it and open) and
  // covers the rail.
  val root = remember { FocusRequester() }
  val immersive = LocalImmersive.current
  DisposableEffect(artMode) {
    immersive.value = artMode
    if (artMode) runCatching { root.requestFocus() }
    onDispose { immersive.value = false }
  }
  val track = now.track
  val accent = track?.coverAccent?.let(::hexColor) ?: track?.coverColor?.let(::hexColor) ?: Palette.ink800
  Box(
    Modifier
      .fillMaxSize()
      .focusRequester(root)
      .focusProperties { canFocus = artMode }
      .focusable()
      .background(Brush.radialGradient(listOf(accent.copy(alpha = if (artMode) 0.25f else 0.45f), Palette.ink950), radius = 1400f))
      .onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        lastKey = System.currentTimeMillis()
        // The first key only wakes the screen.
        if (artMode) {
          artMode = false
          true
        } else false
      },
  ) {
    if (track == null) {
      Text("Nothing playing. Choose an album, a playlist or a mix.", style = Type.body, modifier = Modifier.align(Alignment.Center))
      return@Box
    }
    AnimatedContent(artMode, transitionSpec = { fadeIn(tween(1200)) togetherWith fadeOut(tween(1200)) }, label = "art mode") { art ->
      if (art) ArtMode(track) else Controls(track, now.playing, position, now.durationMs, now.upNext)
    }
  }
}

@Composable
private fun Controls(track: Track, playing: Boolean, position: Long, durationMs: Long, upNext: List<Track>) {
  val app = LocalContext.current.playarr
  val playFocus = remember { FocusRequester() }
  LaunchedEffect(Unit) { runCatching { playFocus.requestFocus() } }
  val lyrics by rememberLoad(track.id) { it.send(Api.Library.lyrics(track.id)).lyrics }
  Row(Modifier.fillMaxSize().padding(horizontal = Margins.Horizontal, vertical = Margins.Vertical), horizontalArrangement = Arrangement.spacedBy(48.dp)) {
    Art(track.coverUrl, COVER, track.coverColor, Modifier.size(COVER).align(Alignment.CenterVertically), RoundedCornerShape(6.dp))
    Column(Modifier.weight(1f).fillMaxHeight()) {
      Text("NOW PLAYING", style = Type.kicker)
      Spacer(Modifier.height(6.dp))
      Text(track.title, style = Type.pageTitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text("${track.artistName} · ${track.albumTitle}", style = Type.small, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Spacer(Modifier.height(14.dp))
      Progress(position, durationMs.takeIf { it > 0 } ?: (track.duration * 1000).toLong())
      Spacer(Modifier.height(10.dp))
      Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { app.player.previous() }) { Icon(TvIcons.SkipPrevious, contentDescription = "Previous", modifier = Modifier.size(28.dp)) }
        IconButton(onClick = { app.player.toggle() }, modifier = Modifier.focusRequester(playFocus).size(56.dp)) {
          Icon(if (playing) TvIcons.Pause else Icons.Filled.PlayArrow, contentDescription = if (playing) "Pause" else "Play", modifier = Modifier.size(32.dp))
        }
        IconButton(onClick = { app.player.next() }) { Icon(TvIcons.SkipNext, contentDescription = "Next", modifier = Modifier.size(28.dp)) }
        SleepButton()
      }
      Spacer(Modifier.height(20.dp))
      Box(Modifier.weight(1f).fillMaxWidth()) {
        val words = (lyrics as? Load.Done)?.value
        if (words?.synced?.isNotEmpty() == true) SyncedLyrics(words, position) else UpNext(upNext, words)
      }
    }
  }
}

/** The cover's size beside the controls: the page's height, less its margins. */
private val COVER = 420.dp

@Composable
private fun Progress(positionMs: Long, durationMs: Long) {
  val share = if (durationMs > 0) (positionMs.toFloat() / durationMs).coerceIn(0f, 1f) else 0f
  Box(Modifier.fillMaxWidth().height(4.dp).background(Palette.line, RoundedCornerShape(2.dp))) {
    Box(Modifier.fillMaxWidth(share).fillMaxHeight().background(Palette.paper, RoundedCornerShape(2.dp)))
  }
  Spacer(Modifier.height(6.dp))
  Row {
    Text(duration(positionMs / 1000.0), style = Type.meta)
    Spacer(Modifier.weight(1f))
    Text(duration(durationMs / 1000.0), style = Type.meta)
  }
}

/** The sleep timer: Off → 15 → 30 → 45 → 60 → 90 min → end of song → off, one press at a time. */
@Composable
private fun SleepButton() {
  val sleep = LocalContext.current.playarr.sleep
  val state by sleep.current.collectAsStateWithLifecycle()
  var tick by remember { mutableLongStateOf(0L) }
  LaunchedEffect(state) { while (state.endsAt != null) { delay(30_000); tick++ } }
  val label = remember(state, tick) { sleep.label() }
  OutlinedButton(onClick = {
    val options = me.tracklistme.playarr.player.SleepTimer.OPTIONS
    val minutes = state.endsAt?.let { java.time.Duration.between(java.time.Instant.now(), it).toMinutes() + 1 }
    when {
      state.endOfSong -> sleep.cancel()
      minutes == null -> sleep.sleep(options.first())
      else -> options.firstOrNull { it > minutes }?.let(sleep::sleep) ?: sleep.sleepAtEndOfSong()
    }
  }) { Text(label?.let { "Sleep · $it" } ?: "Sleep timer", style = Type.label) }
}

/** The words in time: the line being sung bright and kept near the top third, the rest dim. */
@Composable
private fun SyncedLyrics(lyrics: Lyrics, positionMs: Long) {
  val lines = lyrics.synced.orEmpty()
  val seconds = positionMs / 1000.0
  val current = lines.indexOfLast { it.at <= seconds }.coerceAtLeast(0)
  val list = rememberLazyListState()
  LaunchedEffect(current) { list.animateScrollToItem((current - 2).coerceAtLeast(0)) }
  LazyColumn(state = list, verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.fillMaxSize()) {
    itemsIndexed(lines) { index, line ->
      Text(
        line.text.ifBlank { "♪" },
        style = Type.sectionTitle.copy(color = if (index == current) Palette.paper else Palette.paper.copy(alpha = 0.35f)),
      )
    }
  }
}

@Composable
private fun UpNext(upNext: List<Track>, lyrics: Lyrics?) {
  Column(Modifier.fillMaxSize()) {
    lyrics?.plain?.takeIf { it.isNotBlank() }?.let { words ->
      Text(words, style = Type.body.copy(color = Palette.paperDim), maxLines = 18, overflow = TextOverflow.Ellipsis)
      return
    }
    Text("UP NEXT", style = Type.kicker)
    Spacer(Modifier.height(12.dp))
    if (upNext.isEmpty()) Text("The end of the queue. Similar songs follow when “Keep playing” is on.", style = Type.small)
    upNext.take(8).forEach { t ->
      Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Art(t.coverUrl, 48.dp, t.coverColor, Modifier.size(48.dp))
        Spacer(Modifier.width(16.dp))
        Column {
          Text(t.title, style = Type.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
          Text(t.artistName, style = Type.small, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
      }
    }
  }
}

/** Art mode: the cover drifting over minutes, the song's name dim beside it. Nothing bright stays in one place. */
@Composable
private fun ArtMode(track: Track) {
  val drift = rememberInfiniteTransition(label = "drift")
  val x by drift.animateFloat(-1f, 1f, infiniteRepeatable(tween(97_000, easing = LinearEasing), RepeatMode.Reverse), label = "x")
  val y by drift.animateFloat(-1f, 1f, infiniteRepeatable(tween(71_000, easing = LinearEasing), RepeatMode.Reverse), label = "y")
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Column(Modifier.offset { IntOffset((x * 180).dp.roundToPx(), (y * 90).dp.roundToPx()) }, horizontalAlignment = Alignment.CenterHorizontally) {
      Art(track.coverUrl, 340.dp, track.coverColor, Modifier.size(340.dp).alpha(0.85f), RoundedCornerShape(6.dp))
      Spacer(Modifier.height(20.dp))
      Text(track.title, style = Type.sectionTitle.copy(color = Color(0x99ECE6DC)), maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(track.artistName, style = Type.small.copy(color = Color(0x66ECE6DC)), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
  }
}
