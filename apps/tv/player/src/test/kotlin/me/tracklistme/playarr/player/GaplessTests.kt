package me.tracklistme.playarr.player

import androidx.media3.extractor.Extractor
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.mp4.FragmentedMp4Extractor
import androidx.media3.extractor.text.SubtitleParser
import androidx.media3.test.utils.FakeExtractorInput
import androidx.media3.test.utils.FakeExtractorOutput
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Plan 9 §4's gapless spike, kept: Media3 reads the priming and padding the server writes in iTunSMPB
 * (apps/server/src/media/mp4.ts) from a fragmented MP4 too, and trims AAC by them, so songs join without a gap with no
 * clipping of our own. `stream1.mp4` is a real `levelled.aac` stream from the server: 3 s of silence at 256 kbps
 * (made by `make demo`, 2026-11-15).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class GaplessTests {
  @Test
  fun anEncodedStreamTellsTheDecoderItsPrimingAndPaddingToTheSample() {
    val bytes = javaClass.getResourceAsStream("/stream1.mp4")!!.readBytes()
    val extractor = FragmentedMp4Extractor(SubtitleParser.Factory.UNSUPPORTED, 0)
    val output = FakeExtractorOutput()
    extractor.init(output)
    var input = FakeExtractorInput.Builder().setData(bytes).build()
    val position = PositionHolder()
    while (true) {
      when (extractor.read(input, position)) {
        Extractor.RESULT_END_OF_INPUT -> break
        Extractor.RESULT_SEEK -> input = FakeExtractorInput.Builder().setData(bytes).build().also { it.setPosition(position.position.toInt()) }
      }
    }
    val track = output.trackOutputs.valueAt(0)
    val format = track.lastFormat!!
    assertEquals("audio/mp4a-latm", format.sampleMimeType)
    // The server's PRIMING, always.
    assertEquals(2112, format.encoderDelay)
    // What's left of the last AAC frame after the song: 132 frames of 1024 hold the priming, 3 s and the padding.
    assertEquals(132, track.sampleCount)
    assertEquals(132 * 1024 - 2112 - 3 * 44100, format.encoderPadding)
  }
}
