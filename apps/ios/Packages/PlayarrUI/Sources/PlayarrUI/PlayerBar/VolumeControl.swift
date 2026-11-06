import PlayarrPlayer
import SwiftUI

/// The player bar's volume: mute and a slider for the app's own volume (↑/↓ on a keyboard move it too).
struct VolumeControl: View {
  let player: Player

  var body: some View {
    let display = VolumeDisplay(volume: player.queue.volume, muted: player.queue.muted)
    HStack(spacing: 4) {
      Button { player.toggleMute() } label: {
        Image(systemName: display.systemImage).frame(width: 44, height: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(.paperDim)
      .pointerHover()
      .accessibilityLabel(display.muteLabel)
      .accessibilityIdentifier("playerBar.mute")
      Slider(value: Binding(get: { display.shown }, set: { player.setVolume($0) }), in: 0...1, step: 0.05)
        .frame(width: 100)
        .accessibilityLabel("Volume")
        .accessibilityValue(display.valueText)
        .accessibilityIdentifier("playerBar.volume")
    }
  }
}
