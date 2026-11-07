import PlayarrAPI
import SwiftUI

/// An album from MusicBrainz: cover, title, artist and year, what kind it is, and its Request button (which says how
/// much of it is here, when some is). Opens the album when any of it is here, growing from the cover (`CoverZoom`), else the artist's
/// discography (components/Discover.tsx).
struct DiscoverAlbumCard: View {
  let album: DiscoverAlbum
  var highlighted = false
  var width: CGFloat = ShelfCard.width
  /// On the artist's own page, where their name says nothing: what it is and when ("EP · 2019") instead, and no badge.
  var onArtistPage = false
  @Environment(AccountSession.self) private var session
  /// What the album's page grows from: this card's cover.
  @State private var zoom = CoverZoom.Source()

  init(album: DiscoverAlbum, highlighted: Bool = false, width: CGFloat = ShelfCard.width, onArtistPage: Bool = false) {
    self.album = album
    self.highlighted = highlighted
    self.width = width
    self.onArtistPage = onArtistPage
  }

  /// What it is ("Album", "Compilation"): how much of it is here is the Request button's to say ("3/5").
  private var kind: String { album.secondaryTypes.first ?? album.type }

  /// The line under the title: "Massive Attack · 2010", or on the artist's own page "EP · 2019".
  static func byline(_ album: DiscoverAlbum, onArtistPage: Bool) -> String {
    let year = album.year.map { String($0) }
    let who = onArtistPage ? Format.releaseKind(album.type, album.secondaryTypes) : album.artistName
    return MetaLine.join([who, year])
  }

  var body: some View {
    let byline = Self.byline(album, onArtistPage: onArtistPage)
    VStack(alignment: .leading, spacing: 10) {
      Button(action: open) {
        VStack(alignment: .leading, spacing: 8) {
          Cover(path: album.coverUrl, points: width, label: album.title)
            .frame(width: width, height: width)
            .zoomSource(zoom)
            .saturation(album.availability.state == .available || highlighted ? 1 : 0.85)
            .overlay(alignment: .topLeading) {
              if album.availability.state != .available, !onArtistPage {
                Text(kind.uppercased())
                  .typeRole(.badge)
                  .padding(.horizontal, 6).padding(.vertical, 2)
                  .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: Radius.cover))
                  .padding(8)
              }
            }
            .overlay {
              if highlighted { RoundedRectangle(cornerRadius: Radius.cover).strokeBorder(.tint, lineWidth: 2).padding(-4) }
            }
          VStack(alignment: .leading, spacing: 2) {
            Text(album.title).font(.sans(.subheadline)).lineLimit(1)
            Text(byline).font(.sans(.footnote)).foregroundStyle(.secondary).lineLimit(1)
          }
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(album.title), \(byline)")
      RequestButton(album: AlbumRef(mbid: album.mbid, artistName: album.artistName, albumTitle: album.title), availability: album.availability)
    }
    .frame(width: width, alignment: .leading)
    .id(album.mbid)
  }

  /// The album's page, growing from the cover, or the artist's discography.
  private func open() {
    let route = DiscoverDestination.card(album).route
    if case .album = route { session.router.open(route, from: zoom) } else { session.router.open(route) }
  }
}
