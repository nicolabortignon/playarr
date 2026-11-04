import PlayarrAPI
import SwiftUI

/// A song on a playlist page: greyed out when the viewer's library doesn't have it, the heart, its length and its ⋯
/// menu (apps/web/src/pages/Playlist.tsx PlaylistRow).
struct PlaylistItemRow: View {
  let item: PlaylistItem
  let actions: [PlaylistRowAction]
  let onTap: () -> Void
  let perform: (PlaylistRowAction) -> Void

  @Environment(AccountSession.self) private var session
  @Environment(Theme.self) private var theme

  var body: some View {
    let current = item.track.map { session.player.queue.currentTrack?.fileId == $0.fileId } ?? false
    HStack(spacing: 12) {
      Button(action: onTap) {
        HStack(spacing: 12) {
          Cover(path: item.track?.coverUrl, points: 44, label: item.albumTitle).frame(width: 44, height: 44)
          VStack(alignment: .leading, spacing: 2) {
            Text(item.title).lineLimit(1).foregroundStyle(current ? theme.accent.color : .primary)
            HStack(spacing: 6) {
              Text("\(item.artistName) · \(item.albumTitle)").lineLimit(1)
              if item.track == nil { Text("NOT IN LIBRARY").font(.mono(.caption2)) }
            }
            .font(.sans(.footnote))
            .foregroundStyle(.secondary)
          }
          Spacer(minLength: 8)
          if let track = item.track {
            Text(Format.time(track.duration)).font(.sans(.footnote).monospacedDigit()).foregroundStyle(.secondary)
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(item.track == nil)
      .accessibilityLabel(label)
      if let track = item.track { FavoriteButton(track: track, size: .row) }
      if !actions.isEmpty {
        Menu {
          ForEach(actions.filter { $0 != .remove }, id: \.self) { action in
            Button(action.label, systemImage: action.systemImage) { perform(action) }
          }
          // Phase 8's Show metadata and (with DJ mix on) Edit mix points, before Remove as on the web.
          if let track = item.track { TrackLibraryMenuItems(track: track) }
          if actions.contains(.remove) {
            Button(PlaylistRowAction.remove.label, systemImage: PlaylistRowAction.remove.systemImage, role: .destructive) { perform(.remove) }
          }
        } label: {
          Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel("More for \(item.title)")
      }
    }
    .opacity(item.track == nil ? 0.5 : 1)
    .padding(.vertical, 2)
  }

  private var label: String {
    guard let track = item.track else { return "\(item.title), \(item.artistName), not in your library" }
    return "\(item.title), \(item.artistName), \(item.albumTitle), \(Format.time(track.duration))"
  }
}
