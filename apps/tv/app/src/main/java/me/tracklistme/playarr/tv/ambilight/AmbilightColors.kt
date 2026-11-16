package me.tracklistme.playarr.tv.ambilight

import kotlin.math.roundToInt
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

data class Rgb(val r: Int, val g: Int, val b: Int) {
  fun mix(to: Rgb, t: Float): Rgb = Rgb(lerp(r, to.r, t), lerp(g, to.g, t), lerp(b, to.b, t))

  companion object {
    val Black = Rgb(0, 0, 0)

    /** `#rrggbb` (or `rrggbb`); null for anything else. */
    fun hex(text: String?): Rgb? {
      val digits = text?.trim()?.removePrefix("#") ?: return null
      if (digits.length != 6) return null
      val v = digits.toIntOrNull(16) ?: return null
      return Rgb(v shr 16 and 0xFF, v shr 8 and 0xFF, v and 0xFF)
    }
  }
}

/** A color for each side of the TV. */
data class Sides(val left: Rgb, val top: Rgb, val right: Rgb, val bottom: Rgb) {
  fun mix(to: Sides, t: Float) = Sides(left.mix(to.left, t), top.mix(to.top, t), right.mix(to.right, t), bottom.mix(to.bottom, t))
}

/** How many lights each side has (`ambilight/topology`): a 3-sided TV has none at the bottom. */
data class Topology(val layers: Int, val left: Int, val top: Int, val right: Int, val bottom: Int)

/**
 * The lights from the cover playing (plan 9 §6): the API's `coverAccent` at the sides, its `coverColor` at the bottom
 * and a blend of the two along the top, each brightened so a dark cover still lights the wall. Each light of a side gets
 * the side's color.
 */
object AmbilightColors {
  /** Lights at least this bright (HSV value), so a dark cover isn't the lights off. */
  const val MIN_VALUE = 0.7f

  fun of(coverColor: String?, coverAccent: String?): Sides? {
    val base = Rgb.hex(coverColor)
    val accent = Rgb.hex(coverAccent)
    val side = vivid(accent ?: base ?: return null)
    val bottom = vivid(base ?: accent!!)
    return Sides(left = side, top = side.mix(bottom, 0.5f), right = side, bottom = bottom)
  }

  /** The same hue and saturation at a value of at least MIN_VALUE. */
  fun vivid(c: Rgb): Rgb {
    val max = maxOf(c.r, c.g, c.b)
    val value = max / 255f
    if (value >= MIN_VALUE) return c
    // Black: a dim white.
    if (max == 0) return (MIN_VALUE * 255).roundToInt().let { Rgb(it, it, it) }
    val scale = MIN_VALUE * 255f / max
    return Rgb((c.r * scale).roundToInt().coerceAtMost(255), (c.g * scale).roundToInt().coerceAtMost(255), (c.b * scale).roundToInt().coerceAtMost(255))
  }

  /** `ambilight/cached`'s body: `{"layer1": {"left": {"0": {"r":…,"g":…,"b":…}, …}, …}}`, every layer alike. */
  fun body(colors: Sides, topology: Topology): JsonObject = buildJsonObject {
    for (layer in 1..topology.layers) {
      putJsonObject("layer$layer") {
        side("left", topology.left, colors.left)
        side("top", topology.top, colors.top)
        side("right", topology.right, colors.right)
        side("bottom", topology.bottom, colors.bottom)
      }
    }
  }

  private fun kotlinx.serialization.json.JsonObjectBuilder.side(name: String, count: Int, color: Rgb) {
    if (count <= 0) return
    putJsonObject(name) {
      for (i in 0 until count) putJsonObject("$i") {
        put("r", color.r)
        put("g", color.g)
        put("b", color.b)
      }
    }
  }
}

private fun lerp(a: Int, b: Int, t: Float): Int = (a + (b - a) * t.coerceIn(0f, 1f)).roundToInt()
