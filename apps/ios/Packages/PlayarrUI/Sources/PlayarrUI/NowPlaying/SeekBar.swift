import PlayarrPlayer
import SwiftUI

/// Where the song is, and dragging to go elsewhere: the time so far and the time left.
struct SeekBar: View {
  let player: Player
  @State private var scrubbing: Double?

  var body: some View {
    let duration = max(player.duration, 1)
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
      HStack {
        Text(Format.time(scrubbing ?? player.time))
        Spacer()
        Text("-" + Format.time(max(0, player.duration - (scrubbing ?? player.time))))
      }
      .font(.caption.monospacedDigit())
      .foregroundStyle(.secondary)
      .accessibilityHidden(true)
    }
  }
}
