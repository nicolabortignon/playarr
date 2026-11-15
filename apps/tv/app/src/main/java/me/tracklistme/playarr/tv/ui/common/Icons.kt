package me.tracklistme.playarr.tv.ui.common

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The few icons the TV needs beyond Material's core set, drawn from Material Icons' path data (Apache 2.0): the
 * transport, shuffle, the library and Discover. The rest come from `Icons.Filled` (core).
 */
object TvIcons {
  val Pause: ImageVector by lazy { icon("Pause", "M6,19h4V5H6v14zM14,5v14h4V5h-4z") }
  val SkipNext: ImageVector by lazy { icon("SkipNext", "M6,18l8.5,-6L6,6v12zM16,6v12h2V6h-2z") }
  val SkipPrevious: ImageVector by lazy { icon("SkipPrevious", "M6,6h2v12H6zM9.5,12l8.5,6V6z") }
  val Shuffle: ImageVector by lazy {
    icon(
      "Shuffle",
      "M10.59,9.17L5.41,4L4,5.41l5.17,5.17l1.42,-1.41zM14.5,4l2.04,2.04L4,18.59L5.41,20L17.96,7.46L20,9.5V4h-5.5zM14.83,13.41l-1.41,1.41l3.13,3.13L14.5,20H20v-5.5l-2.04,2.04l-3.13,-3.13z",
    )
  }
  val Library: ImageVector by lazy {
    icon(
      "LibraryMusic",
      "M20,2H8C6.9,2 6,2.9 6,4v12c0,1.1 0.9,2 2,2h12c1.1,0 2,-0.9 2,-2V4C22,2.9 21.1,2 20,2zM18,7h-3v5.5c0,1.38 -1.12,2.5 -2.5,2.5S10,13.88 10,12.5s1.12,-2.5 2.5,-2.5c0.57,0 1.08,0.19 1.5,0.51V5h4V7zM4,6H2v14c0,1.1 0.9,2 2,2h14v-2H4V6z",
    )
  }
  val Discover: ImageVector by lazy {
    icon(
      "Explore",
      "M12,10.9c-0.61,0 -1.1,0.49 -1.1,1.1s0.49,1.1 1.1,1.1c0.61,0 1.1,-0.49 1.1,-1.1S12.61,10.9 12,10.9zM12,2C6.48,2 2,6.48 2,12s4.48,10 10,10s10,-4.48 10,-10S17.52,2 12,2zM14.19,14.19L6,18l3.81,-8.19L18,6L14.19,14.19z",
    )
  }
  val NowPlaying: ImageVector by lazy { icon("Equalizer", "M10,20h4V4h-4V20zM4,20h4v-8H4V20zM16,9v11h4V9H16z") }

  private fun icon(name: String, path: String): ImageVector =
    ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).addPath(addPathNodes(path), fill = SolidColor(Color.Black)).build()
}
