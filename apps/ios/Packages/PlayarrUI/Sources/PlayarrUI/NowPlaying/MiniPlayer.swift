import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// The mini player above the tabs (apps/web/src/components/PlayerBar.tsx `MiniPlayer`): tap to open Now Playing.
struct MiniPlayer: View {
  let session: AccountSession
  @Environment(Theme.self) private var theme

  var body: some View {
    let player = session.player
    if let track = player.queue.currentTrack {
      HStack(spacing: 12) {
        Button { session.router.nowPlaying = true } label: {
          HStack(spacing: 12) {
            Cover(path: track.coverUrl, points: 36, label: track.albumTitle, corner: 6).frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 0) {
              Text(track.title).font(.sans(.subheadline)).lineLimit(1)
              Text(track.artistName).font(.sans(.caption)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open now playing")
        .accessibilityValue("\(track.title), \(track.artistName)")
        PlayPauseButton(player: player, size: 36, filled: false)
        Button { player.next() } label: { Image(systemName: "forward.fill").frame(width: 36, height: 36) }
          .buttonStyle(.plain)
          .accessibilityLabel("Next")
      }
      .padding(.horizontal, 12)
      .overlay(alignment: .bottom) {
        GeometryReader { geometry in
          let fraction = player.duration > 0 ? min(1, player.time / player.duration) : 0
          Capsule().fill(theme.accent.color).frame(width: geometry.size.width * fraction, height: 2)
        }
        .frame(height: 2)
        .padding(.horizontal, 12)
        .accessibilityHidden(true)
      }
      .accessibilityIdentifier("miniPlayer")
    }
  }
}
