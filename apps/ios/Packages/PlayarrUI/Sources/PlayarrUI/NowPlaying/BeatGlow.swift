import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// A soft glow of the accent behind Now Playing's cover, breathing on each bar's downbeat (plan 7 §2; docs/design.md,
/// Moments; the web's `BeatGlow`): in over the end of a bar, out from its downbeat, deeper in the busier phrases (the
/// song's energy, from its mix map). A quarter of the accent at most, never a flash. Only for a song with a steady
/// beat grid and only while the music plays: it comes in over 0.7 s, and goes as slowly when paused. Not there at all
/// under Reduce Motion. Its frames are made outside the main actor, as SwiftUI may draw them off the main thread.
struct BeatGlow: View {
  let player: Player
  let track: Track
  let playing: Bool
  @Environment(\.reducesMotion) private var reducesMotion
  /// When Now Playing opened: the glow comes in from then, or from when the music started, whichever is later.
  @State private var opened = Pulse.hostNow()

  /// The glow at rest, and how much a breath adds at most (in the busiest phrases).
  nonisolated static let rest = 0.08
  nonisolated static let breath = 0.16
  /// How much a breath swells the glow.
  nonisolated static let swell = 0.04
  /// It comes in over this long as the music plays, and goes as slowly when paused.
  nonisolated static let fade = 0.7
  /// How far it reaches past the cover on each side (the web's `-inset-[7%]`), and how soft its edge is.
  static let reach = 1.14
  static let blur: CGFloat = 40

  var body: some View {
    if !reducesMotion, let beat = SongBeat(player.transitions.mixMaps.map(track.recordingId)) {
      TimelineView(
        .animation(minimumInterval: 1.0 / 30, paused: !playing),
        content: Self.breathing(glow, pulse: player.pulse, beat: beat, playing: playing, opened: opened)
      )
      .animation(.easeOut(duration: Self.fade), value: playing)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
    }
  }

  private var glow: some View {
    RoundedRectangle(cornerRadius: Radius.panel).fill(.tint).scaleEffect(Self.reach).blur(radius: Self.blur)
  }

  /// The glow at each frame: as strong and as large as its breath, faded in from when it can first be seen.
  nonisolated static func breathing<Glow: View>(_ glow: Glow, pulse: Pulse, beat: SongBeat, playing: Bool, opened: Double)
    -> (TimelineViewDefaultContext) -> AnyView
  {
    { _ in
      let now = Pulse.hostNow()
      let frame = pulse.frame(at: now)
      // The same views every frame, paused or not, so pausing eases from where the breath was.
      let pose: (opacity: Double, scale: Double) =
        playing && frame.playing ? Self.pose(beat, at: frame.time, shown: min(frame.playingFor, now - opened)) : (0, 1)
      return AnyView(glow.opacity(pose.opacity).scaleEffect(pose.scale))
    }
  }

  /// How strong (opacity) and how large the glow is `time` seconds into the song, `shown` seconds after it could first
  /// be seen: fade-in × (0.08 + 0.16 × (0.5 + 0.5 × the phrase's energy) × breath), and 1 + 0.04 × breath.
  nonisolated static func pose(_ beat: SongBeat, at time: Double, shown: Double) -> (opacity: Double, scale: Double) {
    let breath = beat.breath(at: time)
    let coming = min(1, max(0, shown / fade))
    return (coming * (rest + Self.breath * (0.5 + 0.5 * beat.energy(at: time)) * breath), 1 + swell * breath)
  }
}
