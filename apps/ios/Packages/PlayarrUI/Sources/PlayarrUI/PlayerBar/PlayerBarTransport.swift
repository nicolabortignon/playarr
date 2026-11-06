import PlayarrPlayer
import SwiftUI

/// Shuffle, previous, play or pause, next and repeat, small enough for the bar (Now Playing has the big ones), and for
/// the deck under the sideways tracklist (a bigger play button).
struct PlayerBarTransport: View {
  let player: Player
  var playSize: CGFloat = 44
  var spacing: CGFloat = 12
  @Environment(Theme.self) private var theme

  var body: some View {
    let q = player.queue
    HStack(spacing: spacing) {
      button("shuffle", label: "Shuffle", on: q.shuffle) { player.toggleShuffle() }
        .accessibilityAddTraits(q.shuffle ? .isSelected : [])
        .sensoryFeedback(Haptic.toggle, trigger: q.shuffle)
      button("backward.fill", label: "Previous") { player.previous() }
      PlayPauseButton(player: player, size: playSize)
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
    .foregroundStyle(on == true ? AnyShapeStyle(theme.accent.color) : on == false ? AnyShapeStyle(.paperDim) : AnyShapeStyle(.primary))
    .pointerHover()
    .accessibilityLabel(label)
  }
}
