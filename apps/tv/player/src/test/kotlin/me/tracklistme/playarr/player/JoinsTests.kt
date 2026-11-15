package me.tracklistme.playarr.player

import me.tracklistme.playarr.api.ApiJson
import me.tracklistme.playarr.api.TransitionAnswer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class JoinsTests {
  private fun ready(aStart: Double, lead: Double?, bResume: Double, tail: Double?): TransitionAnswer.Ready =
    ApiJson.reading.decodeFromString(
      TransitionAnswer.ByTag,
      """{"status":"ready","url":"/transitions/k.flac",${lead?.let { "\"lead\":$it," } ?: ""}${tail?.let { "\"tail\":$it," } ?: ""}
        "plan":{"style":"long","aStart":$aStart,"bStart":10,"length":16,"bResume":$bResume,"switchAt":8,"bRate":[],"aGain":[],
        "bGain":[],"aLowDb":[],"bLowDb":[],"aHighPassHz":[],"reason":"","beats":32}}""",
    ) as TransitionAnswer.Ready

  @Test
  fun aStopsAtTheFirstFrameBoundaryInTheLeadLessThePaddingTheStreamTrims() {
    // The spike's numbers: the file starts at A's sample 88 537 (2.0076 s with a one-second lead), A trims 552.
    val join = Joins.of(ready(aStart = (88_537 + 44_100) / 44_100.0, lead = 1.0, bResume = 154_800 / 44_100.0, tail = 0.0), padding = 552)!!
    assertEquals(90L, join.cutFrame)
    assertEquals(89_496L, join.endSample)
    assertEquals(959L, join.transitionStart)
    assertEquals(154_800L, join.bStart)
    // Just before frame 90 starts (2 089 795 µs): frames 0 to 89 play whole.
    assertEquals(2_089_785L, join.cutUs)
  }

  @Test
  fun withoutPaddingTheBoundaryItselfAndBGoesOnAfterTheTail() {
    val join = Joins.of(ready(aStart = 60.0, lead = 3.0, bResume = 12.5, tail = 3.0), padding = 0)!!
    // The file starts at 57 s = sample 2 513 700; the first boundary after it is frame 2 457's, at 2 513 856.
    assertEquals(2_457L, join.cutFrame)
    assertEquals(2_513_856L, join.endSample)
    assertEquals(156L, join.transitionStart)
    assertEquals(Joins.samples(12.5) + Joins.samples(3.0), join.bStart)
  }

  @Test
  fun noJoinWithoutALeadToCutIn() {
    // An older server's file has no lead: it starts on the mix itself.
    assertNull(Joins.of(ready(aStart = 60.0, lead = null, bResume = 12.5, tail = null), padding = 0))
    // A lead (4 samples) shorter than the way to the next place A can stop (20 samples in).
    assertNull(Joins.of(ready(aStart = 60.0, lead = 0.0001, bResume = 12.5, tail = 3.0), padding = 1000))
  }
}
