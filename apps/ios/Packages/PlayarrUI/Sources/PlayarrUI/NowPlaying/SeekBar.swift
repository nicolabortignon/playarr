import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Where the song is, and dragging to go elsewhere: the time so far and the time left. Now Playing's (`energy`) has the
/// song's energy under the line (plan 7 §6, `SongEnergy`), lit to where a drag would land, which seeks where it's
/// pressed too; scrubbing ticks as it passes where the intro ends, the drop lands and the outro starts.
struct SeekBar: View {
  let player: Player
  var energy = false
  @State private var scrubbing: Double?
  /// Each section boundary a scrub passes: a tick (`Haptic.selection`).
  @State private var detents = 0
  @State private var stripWidth: CGFloat = 0

  /// The system slider's thumb, 37 points wide, travels from half its width in from each end: the energy strip keeps
  /// to that stretch, so a phrase sits under the thumb at its time.
  static let thumbInset: CGFloat = 18.5

  var body: some View {
    let duration = max(player.duration, 1)
    let map = energy ? player.queue.currentTrack.flatMap { player.transitions.mixMaps.map($0.recordingId) } : nil
    let boundaries = EnergyPicture.sectionBoundaries(map, duration: player.duration)
    VStack(spacing: 4) {
      Slider(
        value: Binding(get: { scrubbing ?? player.time }, set: { scrubbing = $0 }),
        in: 0...duration,
        onEditingChanged: { editing in
          if !editing, let to = scrubbing {
            player.seek(to: to)
            scrubbing = nil
          }
        }
      )
      .accessibilityLabel("Seek")
      .accessibilityValue(Format.time(scrubbing ?? player.time))
      if energy {
        strip(EnergyPicture.songPhrases(map, duration: player.duration), duration: duration)
      }
      HStack {
        Text(Format.time(scrubbing ?? player.time))
        Spacer()
        Text("-" + Format.time(max(0, player.duration - (scrubbing ?? player.time))))
      }
      .font(.sans(.caption).monospacedDigit())
      .foregroundStyle(.secondary)
      .accessibilityHidden(true)
    }
    .onChange(of: scrubbing.map { EnergyPicture.section($0, boundaries: boundaries) }) { before, now in
      if let before, let now, before != now { detents += 1 }
    }
    .sensoryFeedback(Haptic.selection, trigger: detents)
  }

  /// The song's energy, lit to where the song is or a drag would land; pressed or dragged, it scrubs there too.
  private func strip(_ phrases: [EnergyPicture.Phrase], duration: Double) -> some View {
    SongEnergy(phrases: phrases, lit: (scrubbing ?? player.time) / duration)
      .padding(.horizontal, Self.thumbInset)
      .contentShape(Rectangle())
      .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { stripWidth = $0 }
      .gesture(
        DragGesture(minimumDistance: 0)
          .onChanged { drag in scrubbing = Self.time(at: drag.location.x, width: stripWidth, duration: duration) }
          .onEnded { drag in
            player.seek(to: Self.time(at: drag.location.x, width: stripWidth, duration: duration))
            scrubbing = nil
          },
        isEnabled: !phrases.isEmpty)
  }

  /// The time under a point of the strip `width` points wide, its ends where the thumb's travel ends.
  static func time(at x: CGFloat, width: CGFloat, duration: Double) -> Double {
    let travel = max(1, width - 2 * thumbInset)
    return Double(min(1, max(0, (x - thumbInset) / travel))) * duration
  }
}
