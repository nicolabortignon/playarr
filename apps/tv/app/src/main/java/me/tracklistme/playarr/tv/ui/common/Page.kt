package me.tracklistme.playarr.tv.ui.common

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.Icon
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import me.tracklistme.playarr.tv.ui.theme.Type

/** The page's margins at three metres (overscan-safe: 5% of 960 × 540 dp). */
object Margins {
  val Horizontal = 48.dp
  val Vertical = 27.dp
}

/**
 * A page's head, as plan 6 §4 made them: the art, a kicker, the title, a line of facts, and Play and Shuffle first.
 * `playFocus` takes the first focus as the page opens, so the remote's OK plays.
 */
@Composable
fun PageHeader(
  kicker: String,
  title: String,
  facts: String?,
  art: (@Composable () -> Unit)?,
  onPlay: (() -> Unit)?,
  onShuffle: (() -> Unit)?,
  playFocus: FocusRequester? = null,
  more: @Composable () -> Unit = {},
) {
  Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(32.dp)) {
    art?.invoke()
    Column(Modifier.weight(1f)) {
      Text(kicker.uppercase(), style = Type.kicker)
      Spacer(Modifier.height(6.dp))
      Text(title, style = Type.pageTitle, maxLines = 2, overflow = TextOverflow.Ellipsis)
      facts?.let {
        Spacer(Modifier.height(8.dp))
        Text(it, style = Type.meta, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      Spacer(Modifier.height(20.dp))
      Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        onPlay?.let { play -> Button(onClick = play, modifier = playFocus?.let { Modifier.focusRequester(it) } ?: Modifier) { IconLabel(Icons.Filled.PlayArrow, "Play") } }
        onShuffle?.let { shuffle -> OutlinedButton(onClick = shuffle) { IconLabel(TvIcons.Shuffle, "Shuffle") } }
        more()
      }
    }
  }
}

@Composable
fun IconLabel(icon: ImageVector, label: String) {
  Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp))
  Spacer(Modifier.width(8.dp))
  Text(label, style = Type.label)
}

/** A titled row of cards that scrolls sideways, for Home and the artist page. */
fun <T> LazyListScope.cardRow(title: String, items: List<T>, key: (T) -> Any, card: @Composable (T) -> Unit) {
  if (items.isEmpty()) return
  item(key = "title:$title") { Text(title, style = Type.sectionTitle, modifier = Modifier.padding(top = 20.dp, bottom = 12.dp)) }
  item(key = "row:$title") {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(24.dp), modifier = Modifier.fillMaxWidth()) {
      items(items, key = key) { card(it) }
    }
  }
}

/** Space under a row, so a focused card's growth isn't clipped. */
val RowGap: Dp = 16.dp
