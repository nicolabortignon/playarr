import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// A song in a list (apps/web/src/components/TrackList.tsx): its number on album pages, or its cover with the
/// artist and album in mixed lists; the title in the accent colour while it plays; its length and the ⋯ menu.
struct TrackRow: View {
  enum Style { case album, mixed }

  let track: Track
  var style: Style = .album
  let onTap: () -> Void

  @Environment(AccountSession.self) private var session
  @Environment(Theme.self) private var theme
  @Environment(\.reducesMotion) private var reducesMotion

  var body: some View {
    let current = session.player.queue.currentTrack?.fileId == track.fileId
    let playing = current && session.player.queue.playing
    HStack(spacing: 12) {
      Button(action: onTap) {
        AdaptiveStack(spacing: 12) {
          leading(current: current, playing: playing)
          VStack(alignment: .leading, spacing: 2) {
            Text(track.title).essentialLineLimit().foregroundStyle(current ? theme.accent.color : .primary)
            if style == .mixed {
              Text("\(track.artistName) · \(track.albumTitle)").font(.sans(.footnote)).essentialLineLimit().foregroundStyle(.muted)
            }
          }
          OfflineMark(store: session.player.downloads, fileId: track.fileId)
          Spacer(minLength: 8)
          Text(Format.time(track.duration)).font(.sans(.footnote).monospacedDigit()).foregroundStyle(.muted)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(accessibilityLabel)
      .accessibilityValue(playing ? "Playing" : current ? "Paused" : "")
      .accessibilityHint(current ? "Plays or pauses the song" : "Plays the song")
      .accessibilityActions {
        TrackMenuItems(track: track, showsAlbum: style == .mixed)
        Button(session.isFavorite(track) ? "Remove from Favorites" : "Add to Favorites") { session.toggleFavorite(track) }
      }
      .draggable(TrackDrag(tracks: [track])) {
        Label(track.title, systemImage: "music.note").padding(10).background(.regularMaterial, in: Capsule())
      }
      .pointerHover()
      FavoriteButton(track: track, size: .row)
      TrackMenu(track: track, showsAlbum: style == .mixed)
    }
    .padding(.vertical, 6)
    .contextMenu { TrackMenuItems(track: track, showsAlbum: style == .mixed) }
  }

  @ViewBuilder
  private func leading(current: Bool, playing: Bool) -> some View {
    switch style {
    case .album:
      Group {
        if current {
          Image(systemName: "waveform").symbolEffect(.variableColor.iterative, isActive: playing && !reducesMotion).foregroundStyle(theme.accent.color)
        } else {
          Text("\(track.trackNumber)").font(.sans(.subheadline).monospacedDigit()).foregroundStyle(.muted)
        }
      }
      .frame(width: 28)
    case .mixed:
      Cover(path: track.coverUrl, points: 44, label: track.albumTitle)
        .frame(width: 44, height: 44)
        .overlay {
          if current {
            Image(systemName: "waveform").symbolEffect(.variableColor.iterative, isActive: playing && !reducesMotion)
              .foregroundStyle(.white).frame(maxWidth: .infinity, maxHeight: .infinity).background(.black.opacity(0.5))
          }
        }
    }
  }

  private var accessibilityLabel: String {
    let length = Format.time(track.duration)
    return style == .mixed ? "\(track.title), \(track.artistName), \(track.albumTitle), \(length)" : "\(track.trackNumber). \(track.title), \(length)"
  }
}

/// A song on the album that isn't in the library, greyed out in its place.
struct MissingTrackRow: View {
  let missing: MissingTrack

  var body: some View {
    HStack(spacing: 12) {
      Text("\(missing.trackNumber)").font(.sans(.subheadline).monospacedDigit()).frame(width: 28)
      Text(missing.title).lineLimit(1)
      Spacer()
      Text(Format.time(missing.duration)).font(.sans(.footnote).monospacedDigit())
    }
    // Greyed out, as the web's, but still readable (white at 50% passes 4.5:1 on Playarr's dark).
    .foregroundStyle(Color.white.opacity(0.5))
    .padding(.vertical, 6)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(missing.trackNumber). \(missing.title), not in your library")
  }
}
