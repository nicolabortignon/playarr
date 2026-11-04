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
            // The cover, round, ringed by how far into the song it is (filling clockwise from the top), rather than a bar
            // along the glass's edge: the accessory's own inset kept a bar off its bottom.
            Cover(path: track.coverUrl, points: 32, label: track.albumTitle, circle: true)
              .frame(width: 32, height: 32)
              .padding(4)
              .overlay {
                ProgressRing(fraction: player.duration > 0 ? min(1, player.time / player.duration) : 0, lineWidth: 2)
                  .tint(theme.accent.color)
                  .accessibilityHidden(true)
              }
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
        PlayPauseButton(player: player, size: 44, filled: false)
        Button { player.next() } label: { Image(systemName: "forward.fill").frame(width: 44, height: 44).contentShape(Rectangle()) }
          .buttonStyle(.plain)
          .accessibilityLabel("Next")
      }
      .padding(.leading, 6)
      .padding(.trailing, 12)
      .accessibilityIdentifier("miniPlayer")
    }
  }
}
