import PlayarrPlayer
import SwiftUI

/// Shuffle, previous, play or pause, next and repeat, small enough for the bar (Now Playing has the big ones).
struct PlayerBarTransport: View {
  let player: Player
  @Environment(Theme.self) private var theme

  var body: some View {
    let q = player.queue
    HStack(spacing: 12) {
      button("shuffle", label: "Shuffle", on: q.shuffle) { player.toggleShuffle() }
        .accessibilityAddTraits(q.shuffle ? .isSelected : [])
        .sensoryFeedback(Haptic.toggle, trigger: q.shuffle)
      button("backward.fill", label: "Previous") { player.previous() }
      PlayPauseButton(player: player, size: 44)
      button("forward.fill", label: "Next") { player.next() }
      button(q.repeatMode == .one ? "repeat.1" : "repeat", label: "Repeat: \(q.repeatMode.rawValue)", on: q.repeatMode != .off) { player.cycleRepeat() }
        .sensoryFeedback(Haptic.toggle, trigger: q.repeatMode)
    }
  }

  private func button(_ image: String, label: String, on: Bool? = nil, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: image).frame(width: 44, height: 44).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .foregroundStyle(on == true ? AnyShapeStyle(theme.accent.color) : on == false ? AnyShapeStyle(.muted) : AnyShapeStyle(.primary))
    .pointerHover()
    .accessibilityLabel(label)
  }
}
