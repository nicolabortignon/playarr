import PlayarrPlayer
import SwiftUI

/// The bars marking the song playing (docs/design.md, the song playing; apps/web/src/components/Equalizer.tsx): three,
/// the bass, the middle and the treble. For a song with a steady beat grid they follow the music (plan 7 §2): each as
/// loud as its part of what's heard (the engine's meter), landing on the beat (the treble on half beats), settling
/// when the music stops. A song without one keeps the loop, which freezes when the music stops. Still under Reduce
/// Motion. Their frames are made outside the main actor: SwiftUI may draw them off the main thread (build 684).
struct Equalizer: View {
  let playing: Bool
  @Environment(AccountSession.self) private var session
  @Environment(\.reducesMotion) private var reducesMotion
  /// When the loop began: its bars are posed by the time since.
  @State private var start = Date()
  @ScaledMetric(relativeTo: .body) private var height: CGFloat = 14

  /// The bars' shape where they don't move (Reduce Motion), and where their loop starts.
  nonisolated static let shape = BandLevels(bass: 0.9, middle: 0.5, treble: 0.75)

  var body: some View {
    let player = session.player
    let beat = SongBeat(player.queue.currentTrack.flatMap { player.transitions.mixMaps.map($0.recordingId) })
    Group {
      if reducesMotion {
        EqualizerBars(heights: Self.shape)
      } else if let beat {
        // Paused, the bars ease down to rest; while it plays they're set every frame, nothing easing them.
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: !playing), content: Self.following(player.pulse, beat: beat, playing: playing))
          .animation(.easeOut(duration: 0.25), value: playing)
      } else {
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: !playing), content: Self.looping(since: start))
      }
    }
    .frame(width: height * 13 / 14, height: height)
    .accessibilityHidden(true)
  }

  /// The bars following the music: rest while nothing is heard.
  nonisolated static func following(_ pulse: Pulse, beat: SongBeat, playing: Bool) -> (TimelineViewDefaultContext) -> EqualizerBars {
    { _ in
      let frame = pulse.frame()
      guard playing, frame.playing, let levels = frame.levels else { return EqualizerBars(heights: SongBeat.rest) }
      return EqualizerBars(heights: beat.barHeights(at: frame.time, levels: levels))
    }
  }

  nonisolated static func looping(since start: Date) -> (TimelineViewDefaultContext) -> EqualizerBars {
    { context in EqualizerBars(heights: loop(at: context.date.timeIntervalSince(start))) }
  }

  /// The loop `elapsed` seconds in (the web's `eq` keyframes): each bar from its shape's height down to a quarter of
  /// it and back, easing in and out, over 0.7, 0.8 and 0.9 s, starting 0.15 s apart.
  nonisolated static func loop(at elapsed: Double) -> BandLevels {
    func bar(_ index: Int, _ full: Double) -> Double {
      let period = 0.7 + 0.1 * Double(index)
      let t = elapsed - 0.15 * Double(index)
      guard t > 0 else { return full }
      let lap = t / period
      let way = lap - lap.rounded(.down)
      // Up from a quarter on the even laps, back down on the odd (`alternate`).
      let rising = Int(lap.rounded(.down)).isMultiple(of: 2)
      let x = rising ? way : 1 - way
      return full * (0.25 + 0.75 * UnitCurve.easeInOut.value(at: x))
    }
    return BandLevels(bass: bar(0, shape.bass), middle: bar(1, shape.middle), treble: bar(2, shape.treble))
  }
}

/// The three bars, standing on the bottom of their box: 3 points wide with 2 between at 14 points tall, each `heights`
/// of the box's height, their corners a little rounded (the web's `rounded-[1px]`). Animatable, so they ease down to rest.
struct EqualizerBars: Shape {
  var heights: BandLevels

  /// A bar's corners: a mark, not a surface.
  nonisolated static let round: CGFloat = 1

  nonisolated var animatableData: AnimatablePair<Double, AnimatablePair<Double, Double>> {
    get { AnimatablePair(heights.bass, AnimatablePair(heights.middle, heights.treble)) }
    set { heights = BandLevels(bass: newValue.first, middle: newValue.second.first, treble: newValue.second.second) }
  }

  nonisolated func path(in rect: CGRect) -> Path {
    let unit = rect.width / 13
    var path = Path()
    for (index, height) in [heights.bass, heights.middle, heights.treble].enumerated() {
      let tall = rect.height * min(1, max(0, height))
      let bar = CGRect(x: rect.minX + CGFloat(index) * 5 * unit, y: rect.maxY - tall, width: 3 * unit, height: tall)
      path.addRoundedRect(in: bar, cornerSize: CGSize(width: Self.round, height: Self.round))
    }
    return path
  }
}
