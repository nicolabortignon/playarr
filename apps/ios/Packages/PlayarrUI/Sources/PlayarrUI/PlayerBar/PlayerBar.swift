import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// The bar along the bottom of the iPad layout (apps/web/src/components/PlayerBar.tsx `PlayerBar`): the song (its
/// cover opens Now Playing, its title the album, its artist the artist) and the heart; the transport and the seek
/// bar; the format, the queue and lyrics columns, and the volume. At the accessibility text sizes the three parts
/// stack.
struct PlayerBar: View {
  let session: AccountSession
  @Environment(Theme.self) private var theme
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let player = session.player
    AdaptiveStack(spacing: 16) {
      song(player.queue.currentTrack)
        .frame(maxWidth: typeSize.isAccessibilitySize ? nil : .infinity, alignment: .leading)
      VStack(spacing: 0) {
        PlayerBarTransport(player: player)
        SeekBar(player: player)
      }
      .frame(maxWidth: 640)
      .disabled(player.queue.currentTrack == nil)
      controls(player)
        .frame(maxWidth: typeSize.isAccessibilitySize ? nil : .infinity, alignment: .trailing)
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 8)
    .background(.bar)
    .overlay(alignment: .top) {
      // The accent's glow along the top edge, tinted by the cover playing.
      LinearGradient(colors: [.clear, theme.accent.color.opacity(0.5), .clear], startPoint: .leading, endPoint: .trailing)
        .frame(height: 1)
        .accessibilityHidden(true)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("playerBar")
  }

  @ViewBuilder
  private func song(_ track: Track?) -> some View {
    if let track {
      HStack(spacing: 14) {
        Button { session.router.nowPlaying = true } label: {
          Cover(path: track.coverUrl, points: 56, label: track.albumTitle, corner: 3).frame(width: 56, height: 56)
        }
        .buttonStyle(.plain)
        .pointerHover()
        .accessibilityLabel("Open now playing")
        .accessibilityValue("\(track.title), \(track.artistName)")
        // One target, 44 points high, for the title and artist: the album, or the artist from its menu.
        Button { session.router.open(.album(track.albumId)) } label: {
          VStack(alignment: .leading, spacing: 2) {
            Text(track.title).font(.subheadline).essentialLineLimit()
            Text(track.artistName).font(.caption).foregroundStyle(.paperDim).essentialLineLimit()
          }
          .frame(minHeight: 44, alignment: .leading)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerHover()
        .accessibilityLabel("\(track.title), \(track.artistName)")
        .accessibilityHint("Opens the album")
        .accessibilityAction(named: "Go to artist") { session.router.open(.artist(track.artistId)) }
        .contextMenu {
          Button("Go to album", systemImage: "square.stack") { session.router.open(.album(track.albumId)) }
          Button("Go to artist", systemImage: "music.mic") { session.router.open(.artist(track.artistId)) }
        }
        FavoriteButton(track: track)
      }
    } else {
      Kicker(text: "Nothing playing")
    }
  }

  private func controls(_ player: Player) -> some View {
    HStack(spacing: 4) {
      if let format = player.queue.currentTrack?.format, !typeSize.isAccessibilitySize {
        FormatBadge(format: format).padding(.trailing, 8)
      }
      ForEach(SideColumn.allCases, id: \.self) { column in
        columnButton(column)
      }
      VolumeControl(player: player)
    }
  }

  private func columnButton(_ column: SideColumn) -> some View {
    let router = session.router
    let open = router.column == column
    return Button { router.column = open ? nil : column } label: {
      Image(systemName: column.systemImage).frame(width: 44, height: 44).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .foregroundStyle(open ? AnyShapeStyle(theme.accent.color) : AnyShapeStyle(.paperDim))
    .pointerHover()
    .accessibilityLabel(column.title)
    .accessibilityAddTraits(open ? .isSelected : [])
    .accessibilityIdentifier("playerBar.\(column.rawValue)")
    .sensoryFeedback(Haptic.toggle, trigger: open)
  }
}
