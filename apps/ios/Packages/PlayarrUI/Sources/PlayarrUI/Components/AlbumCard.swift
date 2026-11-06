import PlayarrAPI
import SwiftUI

/// An album in a grid or shelf: its cover, title (in the accent color while it plays), artist, year, and "3 of 11"
/// when songs are missing (apps/web/src/components/Cards.tsx). On the artist's own page their name says nothing, so
/// it says what the album is instead ("EP · 2019"). A long press opens the album's menu, Play and Shuffle first
/// (`PlayableMenu.album`).
struct AlbumCard: View {
  let album: Album
  var width: CGFloat?
  /// On the artist's own page: the release's kind in place of their name.
  var onArtistPage = false

  @Environment(AccountSession.self) private var session
  @Environment(Theme.self) private var theme

  var body: some View {
    let current = session.player.queue.currentTrack?.albumId == album.id
    NavigationLink(value: Route.album(album.id)) {
      VStack(alignment: .leading, spacing: 6) {
        Cover(path: album.coverUrl, points: width ?? 180, label: album.title)
          .coverShadow(.shelf)
        Text(album.title).typeRole(.body).essentialLineLimit().foregroundStyle(current ? theme.accent.color : .paper)
        Text(subtitle).typeRole(.small).essentialLineLimit().foregroundStyle(.paperDim)
      }
      .frame(width: width)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .pointerHover()
    .accessibilityLabel("\(album.title), \(subtitle)")
    .accessibilityAddTraits(current ? [.isButton, .isSelected] : .isButton)
    // The album's one menu, Play and Shuffle first: a card has neither button.
    .contextMenu { MenuButtons(groups: PlayableMenu.album(album.id, artistId: album.artistId, card: true, session: session)) }
    .prefetch { session.prefetchAlbum(album.id, cover: album.coverUrl) }
  }

  /// "Massive Attack · 1998 · 3 of 11", or on the artist's page "Album · 1998 · 3 of 11".
  var subtitle: String { Self.subtitle(album, onArtistPage: onArtistPage) }

  static func subtitle(_ album: Album, onArtistPage: Bool) -> String {
    var parts = [onArtistPage ? Format.releaseKind(album.albumType, album.secondaryTypes) : album.artistName]
    if let year = album.year { parts.append(String(year)) }
    if album.trackCount < album.totalTrackCount { parts.append("\(album.trackCount) of \(album.totalTrackCount)") }
    return parts.joined(separator: " · ")
  }
}
