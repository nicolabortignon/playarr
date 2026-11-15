package me.tracklistme.playarr.tv.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import me.tracklistme.playarr.tv.playarr
import me.tracklistme.playarr.tv.ui.theme.Palette
import me.tracklistme.playarr.tv.ui.theme.Type

/** The widths cards are shown at (plan 9 §5: covers asked for at the size they're shown, never full size). */
object CardWidth {
  val Cover = 150.dp
  val Large = 220.dp
}

/** An image from the server (`/art`), asked for at `size`, on the cover's own color while it loads. */
@Composable
fun Art(path: String?, size: Dp, color: String?, modifier: Modifier = Modifier, shape: Shape = RoundedCornerShape(4.dp)) {
  val media = LocalContext.current.playarr.media()
  val pixels = with(LocalDensity.current) { size.roundToPx() }
  AsyncImage(
    model = media?.art(path, pixels),
    contentDescription = null,
    contentScale = ContentScale.Crop,
    modifier = modifier.clip(shape).background(color?.let(::hexColor) ?: Palette.ink800),
  )
}

/** A cover that grows on focus, with a title and a line under it. */
@Composable
fun CoverCard(
  title: String,
  subtitle: String?,
  art: String?,
  color: String? = null,
  width: Dp = CardWidth.Cover,
  round: Boolean = false,
  onClick: () -> Unit,
) {
  val shape = if (round) CircleShape else RoundedCornerShape(4.dp)
  Column(Modifier.width(width)) {
    Card(
      onClick = onClick,
      shape = CardDefaults.shape(shape),
      scale = CardDefaults.scale(focusedScale = 1.08f),
      modifier = Modifier.fillMaxWidth().aspectRatio(1f),
    ) {
      Art(art, width, color, Modifier.fillMaxSize(), shape)
    }
    Spacer(Modifier.height(10.dp))
    Text(title, style = Type.small.copy(color = Palette.paper), maxLines = 1, overflow = TextOverflow.Ellipsis)
    subtitle?.let { Text(it, style = Type.meta, maxLines = 1, overflow = TextOverflow.Ellipsis) }
  }
}

/** "#rrggbb" → Color; null when it isn't one. */
fun hexColor(hex: String): Color? = hex.removePrefix("#").toLongOrNull(16)?.takeIf { hex.length == 7 }?.let { Color(0xFF000000 or it) }

/** "3:07", or "1:02:03". */
fun duration(seconds: Double): String {
  val s = seconds.toLong()
  return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

/** "54 min", or "1 h 12 min", for an album or a playlist. */
fun length(seconds: Double): String {
  val minutes = (seconds / 60).toLong().coerceAtLeast(1)
  return if (minutes >= 60) "${minutes / 60} h ${minutes % 60} min" else "$minutes min"
}

/** "1 song", "12 songs". */
fun count(n: Int, one: String, many: String = "${one}s"): String = "$n ${if (n == 1) one else many}"
