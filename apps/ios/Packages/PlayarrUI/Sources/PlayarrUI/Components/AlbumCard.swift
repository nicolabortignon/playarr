import PlayarrAPI
import SwiftUI

/// An album in a grid or shelf: its cover, title (in the accent colour while it plays), artist, year, and "3 of 11"
/// when songs are missing (apps/web/src/components/Cards.tsx). Long press for Play, Shuffle and the queue.
struct AlbumCard: View {
  let album: Album
  var width: CGFloat?

  @Environment(AccountSession.self) private var session
  @Environment(Theme.self) private var theme

  var body: some View {
    let current = session.player.queue.currentTrack?.albumId == album.id
    NavigationLink(value: Route.album(album.id)) {
      VStack(alignment: .leading, spacing: 6) {
        Cover(path: album.coverUrl, points: width ?? 180, label: album.title)
          .shadow(color: .black.opacity(0.5), radius: 10, y: 6)
        Text(album.title).font(.subheadline).lineLimit(1).foregroundStyle(current ? theme.accent.color : .primary)
        Text(subtitle).font(.caption).lineLimit(1).foregroundStyle(.secondary)
      }
      .frame(width: width)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(album.title), \(subtitle)")
    .accessibilityAddTraits(current ? [.isButton, .isSelected] : .isButton)
    .contextMenu {
      Button("Play", systemImage: "play.fill") { Task { await session.actions.playAlbum(album.id) } }
      Button("Shuffle", systemImage: "shuffle") { Task { await session.actions.playAlbum(album.id, shuffle: true) } }
      Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { Task { await session.actions.queueAlbum(album.id, next: true) } }
      Button("Add to queue", systemImage: "text.append") { Task { await session.actions.queueAlbum(album.id, next: false) } }
      Button("Go to artist", systemImage: "music.mic") { session.router.open(.artist(album.artistId)) }
    }
    .prefetch { session.prefetchAlbum(album.id, cover: album.coverUrl) }
  }

  /// "Massive Attack · 1998 · 3 of 11".
  var subtitle: String {
    var parts = [album.artistName]
    if let year = album.year { parts.append(String(year)) }
    if album.trackCount < album.totalTrackCount { parts.append("\(album.trackCount) of \(album.totalTrackCount)") }
    return parts.joined(separator: " · ")
  }
}
