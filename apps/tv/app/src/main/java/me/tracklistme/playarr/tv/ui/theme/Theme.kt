package me.tracklistme.playarr.tv.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.darkColorScheme
import me.tracklistme.playarr.tv.R

/** docs/design.md's palette: warm ink and paper, the accent orange (the cover's accent comes with Now Playing). */
object Palette {
  val ink950 = Color(0xFF0A0908)
  val ink900 = Color(0xFF0F0E0C)
  val ink850 = Color(0xFF141310)
  val ink800 = Color(0xFF1A1915)
  val ink700 = Color(0xFF24221D)
  val paper = Color(0xFFECE6DC)
  val paperDim = Color(0xFFB8B0A3)
  val muted = Color(0xFF857D71)
  val line = Color(0x14ECE6DC)
  val accent = Color(0xFFFF7A1A)
  val accentInk = Color(0xFF0F0E0C)
  val danger = Color(0xFFF87171)
}

val Gloock = FontFamily(Font(R.font.gloock))
val Schibsted = FontFamily(Font(R.font.schibsted_grotesk))
val DmMono = FontFamily(Font(R.font.dm_mono), Font(R.font.dm_mono_medium, FontWeight.Medium))

/**
 * The type roles of docs/design.md at three metres (its TV column): a 1080p TV is 960×540 dp, seen from the sofa, so
 * each role is about 1.2 times the web's desktop size and never under 14 sp.
 */
object Type {
  val pageTitle = TextStyle(fontFamily = Gloock, fontSize = 48.sp, lineHeight = 52.sp, color = Palette.paper)
  val sectionTitle = TextStyle(fontFamily = Gloock, fontSize = 28.sp, lineHeight = 32.sp, color = Palette.paper)
  val kicker = TextStyle(fontFamily = DmMono, fontSize = 14.sp, letterSpacing = 0.2.em, color = Palette.muted)
  val body = TextStyle(fontFamily = Schibsted, fontSize = 20.sp, lineHeight = 26.sp, color = Palette.paper)
  val small = TextStyle(fontFamily = Schibsted, fontSize = 16.sp, lineHeight = 22.sp, color = Palette.paperDim)
  val meta = TextStyle(fontFamily = DmMono, fontSize = 15.sp, color = Palette.muted)
  /** A button's label: no color of its own, so it takes the button's, ink on the paper a focused button turns. */
  val label = TextStyle(fontFamily = Schibsted, fontSize = 18.sp, lineHeight = 24.sp)
  /** The sign-in code: big enough to read across the room. */
  val code = TextStyle(fontFamily = DmMono, fontWeight = FontWeight.Medium, fontSize = 64.sp, letterSpacing = 0.12.em, color = Palette.paper)
}

@Composable
fun PlayarrTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = darkColorScheme(
      primary = Palette.accent,
      onPrimary = Palette.accentInk,
      background = Palette.ink900,
      onBackground = Palette.paper,
      surface = Palette.ink850,
      onSurface = Palette.paper,
      surfaceVariant = Palette.ink800,
      onSurfaceVariant = Palette.paperDim,
      border = Palette.line,
      error = Palette.danger,
    ),
    content = content,
  )
}
