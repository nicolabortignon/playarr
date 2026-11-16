package me.tracklistme.playarr.tv.ambilight

import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AmbilightColorsTests {
  @Test fun readsHex() {
    assertEquals(Rgb(0x3a, 0x2f, 0x28), Rgb.hex("#3a2f28"))
    assertNull(Rgb.hex("#fff"))
    assertNull(Rgb.hex(null))
  }

  @Test fun darkCoversStillLightTheWall() {
    val dark = AmbilightColors.vivid(Rgb(40, 20, 10))
    assertEquals(179, maxOf(dark.r, dark.g, dark.b))
    assertEquals(Rgb(179, 89, 45), dark)
    assertEquals(Rgb(200, 100, 50), AmbilightColors.vivid(Rgb(200, 100, 50)))
    assertEquals(Rgb(179, 179, 179), AmbilightColors.vivid(Rgb.Black))
  }

  @Test fun accentAtTheSidesColorAtTheBottom() {
    val sides = AmbilightColors.of("#202020", "#c04000")!!
    assertEquals(Rgb(0xc0, 0x40, 0), sides.left)
    assertEquals(sides.left, sides.right)
    assertEquals(Rgb(179, 179, 179), sides.bottom)
    assertEquals(sides.left.mix(sides.bottom, 0.5f), sides.top)
    assertNull(AmbilightColors.of(null, null))
  }

  @Test fun everyLightOfEachSide() {
    val c = Rgb(1, 2, 3)
    val body = AmbilightColors.body(Sides(c, c, c, c), Topology(layers = 1, left = 2, top = 3, right = 2, bottom = 0))
    val layer = body["layer1"]!!.jsonObject
    assertEquals(setOf("left", "top", "right"), layer.keys)
    assertEquals(3, layer["top"]!!.jsonObject.size)
    assertEquals("2", layer["left"]!!.jsonObject["1"]!!.jsonObject["g"]!!.jsonPrimitive.content)
  }
}
