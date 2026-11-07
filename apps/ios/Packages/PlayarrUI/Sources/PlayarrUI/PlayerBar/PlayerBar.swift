import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// The bar along the bottom of the iPad layout (apps/web/src/components/PlayerBar.tsx `PlayerBar`): the song (its
/// cover opens Now Playing, its title the album, a long press its menu) and the heart; the transport and the seek bar;
/// the format, the queue and lyrics columns, and the volume. With nothing playing, what to play instead
/// (`IdlePlayerBar`). At the accessibility text sizes the three parts stack.
struct PlayerBar: View {
  let session: AccountSession
  @Environment(Theme.self) private var theme
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let player = session.player
    AdaptiveStack(spacing: 16) {
      if let track = player.queue.currentTrack {
        song(track)
          .frame(maxWidth: typeSize.isAccessibilitySize ? nil : .infinity, alignment: .leading)
        Self.deck(player)
      } else {
        IdlePlayerBar(session: session)
      }
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

  /// The transport over the seek bar, at most 640 wide: the bar's middle.
  static func deck(_ player: Player) -> some View {
    VStack(spacing: 0) {
      PlayerBarTransport(player: player)
      SeekBar(player: player)
    }
    .frame(maxWidth: 640)
  }

  private func song(_ track: Track) -> some View {
    // The one song menu for the song playing (no Play next or Add to queue), as a row's: from a long press or a
    // secondary click anywhere on the song, and as VoiceOver's actions on its title.
    let menu = SongMenu.groups(track, place: SongMenu.Place(playing: true), session: session)
    return HStack(spacing: 14) {
      Button { session.router.nowPlaying = true } label: {
        Cover(path: track.coverUrl, points: 56, label: track.albumTitle, corner: Radius.cover).frame(width: 56, height: 56)
      }
      .buttonStyle(.plain)
      .pointerHover()
      .accessibilityLabel("Open now playing")
      .accessibilityValue("\(track.title), \(track.artistName)")
      // One target, 44 points high, for the title and artist: the album, or the artist from its menu.
      Button { session.router.open(.album(track.albumId)) } label: {
        VStack(alignment: .leading, spacing: 2) {
          Text(track.title).typeRole(.body).essentialLineLimit()
          Text(track.artistName).typeRole(.small).foregroundStyle(.paperDim).essentialLineLimit()
        }
        .frame(minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .pointerHover()
      .accessibilityLabel("\(track.title), \(track.artistName)")
      .accessibilityHint("Opens the album")
      .accessibilityActions {
        ForEach(menu.flatMap(\.self)) { action in
          Button(action.title, action: action.perform)
        }
      }
      FavoriteButton(track: track)
    }
    .contextMenu { MenuButtons(groups: menu) }
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
