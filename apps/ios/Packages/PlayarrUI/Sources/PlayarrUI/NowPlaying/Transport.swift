import PlayarrPlayer
import SwiftUI

/// Shuffle, previous, play or pause, next, repeat (apps/web/src/components/Transport.tsx).
struct Transport: View {
  let player: Player
  @Environment(Theme.self) private var theme

  var body: some View {
    let q = player.queue
    HStack {
      Button { player.toggleShuffle() } label: { Image(systemName: "shuffle").font(.title3) }
        .foregroundStyle(q.shuffle ? theme.accent.color : .secondary)
        .accessibilityLabel("Shuffle")
        .accessibilityAddTraits(q.shuffle ? .isSelected : [])
        .sensoryFeedback(.selection, trigger: q.shuffle)
      Spacer()
      Button { player.previous() } label: { Image(systemName: "backward.fill").font(.title) }
        .accessibilityLabel("Previous")
      Spacer()
      PlayPauseButton(player: player, size: 72)
      Spacer()
      Button { player.next() } label: { Image(systemName: "forward.fill").font(.title) }
        .accessibilityLabel("Next")
      Spacer()
      Button { player.cycleRepeat() } label: { Image(systemName: q.repeatMode == .one ? "repeat.1" : "repeat").font(.title3) }
        .foregroundStyle(q.repeatMode == .off ? .secondary : theme.accent.color)
        .accessibilityLabel(NowPlayingModel(player: player).repeatLabel)
        .sensoryFeedback(.selection, trigger: q.repeatMode)
    }
    .buttonStyle(.plain)
  }
}

/// Play or pause; a spinner while the song is loading.
struct PlayPauseButton: View {
  let player: Player
  var size: CGFloat = 44
  var filled = true

  var body: some View {
    let playing = player.queue.playing
    Button { player.togglePlay() } label: {
      ZStack {
        if filled { Circle().fill(.primary) }
        if player.loading && playing {
          ProgressView().tint(filled ? Color.black : Color.primary)
        } else {
          Image(systemName: playing ? "pause.fill" : "play.fill")
            .font(.system(size: size * 0.4))
            .foregroundStyle(filled ? Color.black : Color.primary)
        }
      }
      .frame(width: size, height: size)
    }
    .buttonStyle(.plain)
    .disabled(player.queue.pos < 0)
    .accessibilityLabel(playing ? "Pause" : "Play")
    .sensoryFeedback(.impact(weight: .medium), trigger: playing)
  }
}
