package me.tracklistme.playarr.player

import me.tracklistme.playarr.api.ApiError
import me.tracklistme.playarr.api.ApiJson
import me.tracklistme.playarr.api.TransitionAnswer
import me.tracklistme.playarr.api.TransitionRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TransitionAskerTests {
  private var clock = 0L
  private val asked = mutableListOf<TransitionRequest>()
  /** What the server answers next; each answer is used once, the last one for every ask after. */
  private val answers = ArrayDeque<Result<TransitionAnswer>>()
  private val readies = mutableListOf<TransitionAnswer.Ready>()
  private val asker = TransitionAsker({ clock }) { request, done ->
    asked += request
    done(if (answers.size > 1) answers.removeFirst() else answers.first())
  }.also { it.onReady = { _, ready -> readies += ready } }

  private val pair = TransitionAsker.Pair("a>b", track(1, duration = 240.0), track(2, album = 2), albumQueue = false, levels = TransitionAnswer.Ready.Levels(-3.0, -5.0))

  private fun answer(json: String): Result<TransitionAnswer> = Result.success(ApiJson.reading.decodeFromString(TransitionAnswer.ByTag, json))
  private fun plan(aStart: Double) =
    """{"style":"long","aStart":$aStart,"bStart":10,"length":16,"bResume":26,"switchAt":8,"bRate":[],"aGain":[],"bGain":[],"aLowDb":[],"bLowDb":[],"aHighPassHz":[],"reason":"","beats":32}"""
  private fun ready(aStart: Double = 200.0) = answer("""{"status":"ready","url":"/transitions/k.flac","lead":3,"tail":3,"plan":${plan(aStart)}}""")
  private fun pending(aStart: Double = 200.0) = answer("""{"status":"pending","plan":${plan(aStart)}}""")

  /** Plays `playing` from `from` for `seconds`, ticking twice a second. */
  private fun play(from: Double, seconds: Double, playing: TransitionAsker.Pair = pair) {
    var t = from
    while (t <= from + seconds) {
      asker.tick(playing, t)
      t += 0.5
      clock += 500
    }
  }

  @Test
  fun asksOnceFiveSecondsHavePlayedAtTheFirstPositionWithTheSongsFilesAndLevels() {
    answers += ready()
    play(0.0, 4.0)
    assertTrue(asked.isEmpty())
    play(4.5, 2.0)
    val request = asked.single()
    assertEquals(1, request.from)
    assertEquals(2, request.to)
    assertEquals(1, request.fromFileId)
    assertEquals(5.0, request.position!!, 0.6)
    assertEquals(TransitionAnswer.Ready.Levels(-3.0, -5.0), request.levels)
    assertEquals(false, request.albumQueue)
    assertEquals(1, readies.size)
  }

  @Test
  fun pollsWhileTheServerRendersEveryThreeSecondsThenEveryTenKeepingThePosition() {
    answers += listOf(pending(), pending(), pending(), pending(), pending(), pending(), ready())
    play(0.0, 5.0)
    play(5.5, 60.0)
    assertEquals(7, asked.size)
    assertTrue(asked.all { it.position == asked.first().position })
    assertEquals(1, readies.size)
  }

  @Test
  fun givesUpTwentySecondsBeforeTheMix() {
    answers += pending(aStart = 30.0)
    play(0.0, 15.0)
    val asks = asked.size
    play(15.5, 10.0)
    assertEquals(asks, asked.size)
    assertTrue(readies.isEmpty())
  }

  @Test
  fun unavailableIsAskedOnceMoreAfterAMinuteAndStraightOnEndsIt() {
    answers += listOf(answer("""{"status":"unavailable","reason":"No mix map yet"}"""), answer("""{"status":"straight","plan":${plan(200.0)}}"""))
    play(0.0, 6.0)
    assertEquals(1, asked.size)
    // Asked at 5 s: not again before 65 s.
    play(6.5, 58.0)
    assertEquals(1, asked.size)
    play(65.0, 5.0)
    assertEquals(2, asked.size)
    play(71.5, 60.0)
    assertEquals(2, asked.size)
    assertTrue(readies.isEmpty())
  }

  @Test
  fun aServerErrorIsTriedAgainButARefusalEndsIt() {
    answers += listOf(Result.failure(ApiError.Server(503, "Busy")), Result.failure(ApiError.Server(404, "Unknown track")))
    play(0.0, 6.0)
    play(6.5, 30.0)
    assertEquals(2, asked.size)
  }

  @Test
  fun anotherPairStartsAfreshAfterItsOwnFiveSeconds() {
    answers += ready()
    play(0.0, 6.0)
    assertEquals(1, asked.size)
    val next = pair.copy(key = "a>c", to = track(3, album = 3))
    play(6.5, 4.0, next)
    assertEquals(1, asked.size)
    play(11.0, 2.0, next)
    assertEquals(3, asked.last().to)
    assertEquals(2, readies.size)
  }
}
