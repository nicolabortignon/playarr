package me.tracklistme.playarr.tv.ui.common

import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.ListItem
import androidx.tv.material3.ListItemDefaults
import androidx.tv.material3.Text
import me.tracklistme.playarr.api.Track
import me.tracklistme.playarr.tv.ui.theme.Palette
import me.tracklistme.playarr.tv.ui.theme.Type

/**
 * A song in a list: its number (or the playing mark), title, artist when it isn't the page's, and length. OK plays the
 * list from here.
 */
@Composable
fun TrackRow(track: Track, number: Int?, playing: Boolean, showArtist: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
  ListItem(
    selected = playing,
    onClick = onClick,
    headlineContent = { Text(track.title, style = Type.rowTitle, maxLines = 1, overflow = TextOverflow.Ellipsis) },
    supportingContent = if (showArtist) ({ Text(track.artistName, style = Type.rowDetail, maxLines = 1, overflow = TextOverflow.Ellipsis) }) else null,
    leadingContent = {
      if (playing) Icon(TvIcons.NowPlaying, contentDescription = "Playing", modifier = Modifier.size(20.dp))
      else Text(number?.toString() ?: "", style = Type.meta, modifier = Modifier.width(28.dp))
    },
    trailingContent = { Text(duration(track.duration), style = Type.meta) },
    colors = ListItemDefaults.colors(containerColor = Palette.ink900, selectedContainerColor = Palette.ink800),
    modifier = modifier,
  )
}
