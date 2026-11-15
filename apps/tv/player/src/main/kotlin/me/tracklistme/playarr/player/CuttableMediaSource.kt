package me.tracklistme.playarr.player

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.exoplayer.source.ClippingMediaPeriod
import androidx.media3.exoplayer.source.ForwardingTimeline
import androidx.media3.exoplayer.source.MediaPeriod
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.exoplayer.source.WrappingMediaSource
import androidx.media3.exoplayer.upstream.Allocator
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.mp4.FragmentedMp4Extractor
import androidx.media3.extractor.text.SubtitleParser

/**
 * A song's encoded stream (fragmented MP4) whose end can be moved while it plays: a DJ transition is ready only once
 * the song has started, and restarting it to clip it would be heard. Each period is a ClippingMediaPeriod without an
 * end until `cut` gives one; the timeline then says the song is that long, and the next item follows from there.
 *
 * The stream's padding (`iTunSMPB`) is read as it's parsed. When the player read the stream's format before any cut
 * (the usual case: the transition comes once the song plays), it trims that many samples off the end of what it
 * decodes, cut or not, so a cut at a frame boundary stops `padding` samples before it (`trimmed`, for Joins.of). A
 * format read after the cut has its padding cleared by the clipping, and nothing more is trimmed.
 */
@OptIn(UnstableApi::class)
public class CuttableMediaSource private constructor(source: MediaSource, private val formats: Formats) : WrappingMediaSource(source) {
  /** Formats as the extractor reads them (on the loader's thread). */
  internal class Formats {
    /** The padding the player will trim at the end: the stream's, or 0 when its format was read after a cut. */
    @Volatile var trimmed: Int? = null
    @Volatile var cut = false
  }

  private val periods = mutableListOf<ClippingMediaPeriod>()
  private var childTimeline: Timeline? = null

  /** Where the song is cut (µs into its stream), or C.TIME_END_OF_SOURCE. Read and set on the playback thread. */
  public var endUs: Long = C.TIME_END_OF_SOURCE
    private set

  /** The samples the player trims off the end of what it plays of this stream; null until its header is read. */
  public val trimmed: Int? get() = formats.trimmed

  override fun createPeriod(id: MediaSource.MediaPeriodId, allocator: Allocator, startPositionUs: Long): MediaPeriod =
    ClippingMediaPeriod(mediaSource.createPeriod(id, allocator, startPositionUs), false, 0, endUs).also { periods += it }

  override fun releasePeriod(mediaPeriod: MediaPeriod) {
    periods.remove(mediaPeriod)
    mediaSource.releasePeriod((mediaPeriod as ClippingMediaPeriod).mediaPeriod)
  }

  override fun onChildSourceInfoRefreshed(newTimeline: Timeline) {
    childTimeline = newTimeline
    publish()
  }

  /** Ends the song at `endUs` into its stream. Only on the playback thread (a PlayerMessage). */
  public fun cut(endUs: Long) {
    this.endUs = endUs
    formats.cut = true
    periods.forEach { it.updateClipping(0, endUs) }
    publish()
  }

  private fun publish() {
    val timeline = childTimeline ?: return
    refreshSourceInfo(if (endUs == C.TIME_END_OF_SOURCE) timeline else Cut(timeline, endUs))
  }

  /** The song as long as its cut. */
  private class Cut(timeline: Timeline, private val endUs: Long) : ForwardingTimeline(timeline) {
    override fun getWindow(windowIndex: Int, window: Timeline.Window, defaultPositionProjectionUs: Long): Timeline.Window {
      super.getWindow(windowIndex, window, defaultPositionProjectionUs)
      window.durationUs = endUs
      window.isDynamic = false
      return window
    }

    override fun getPeriod(periodIndex: Int, period: Timeline.Period, setIds: Boolean): Timeline.Period {
      super.getPeriod(periodIndex, period, setIds)
      period.durationUs = endUs
      return period
    }
  }

  /** Reads the padding the stream declares, as the extractor hands the track's format on. */
  private class Watched(private val inner: Extractor, private val formats: Formats) : Extractor by inner {
    override fun init(output: ExtractorOutput) =
      inner.init(object : ExtractorOutput by output {
        override fun track(id: Int, type: Int): TrackOutput {
          val track = output.track(id, type)
          return object : TrackOutput by track {
            override fun format(format: Format) {
              formats.trimmed = if (formats.cut || format.encoderPadding == Format.NO_VALUE) 0 else format.encoderPadding
              track.format(format)
            }
          }
        }
      })
  }

  public companion object {
    /** A cuttable source for an encoded stream (`aac` or `levelled.aac`), read through `data`. */
    public fun of(item: MediaItem, data: DataSource.Factory, errors: LoadErrorHandlingPolicy): CuttableMediaSource {
      val formats = Formats()
      val source = ProgressiveMediaSource.Factory(data, ExtractorsFactory { arrayOf(Watched(FragmentedMp4Extractor(SubtitleParser.Factory.UNSUPPORTED, 0), formats)) })
        .setLoadErrorHandlingPolicy(errors)
        .createMediaSource(item)
      return CuttableMediaSource(source, formats)
    }
  }
}
