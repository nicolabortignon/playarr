import PlayarrAPI
import SwiftUI

/// An album from MusicBrainz: cover, title, artist and year, what kind it is (or how much of it is here), and its
/// Request button. Opens the album when any of it is here, else the artist's discography (components/Discover.tsx).
struct DiscoverAlbumCard: View {
  let album: DiscoverAlbum
  var highlighted = false
  var width: CGFloat = ShelfCard.width
  /// On the artist's own page, where their name says nothing: what it is and when ("EP · 2019") instead, and no badge.
  var onArtistPage = false

  init(album: DiscoverAlbum, highlighted: Bool = false, width: CGFloat = ShelfCard.width, onArtistPage: Bool = false) {
    self.album = album
    self.highlighted = highlighted
    self.width = width
    self.onArtistPage = onArtistPage
  }

  private var kind: String {
    let a = album.availability
    let partial = a.state == .partial || (a.have != nil && a.albumId != nil)
    if partial, let have = a.have, let total = a.total, total > 0 { return "\(have) of \(total)" }
    return album.secondaryTypes.first ?? album.type
  }

  /// The line under the title: "Massive Attack · 2010", or on the artist's own page "EP · 2019".
  static func byline(_ album: DiscoverAlbum, onArtistPage: Bool) -> String {
    let year = album.year.map { String($0) }
    let who = onArtistPage ? Format.releaseKind(album.type, album.secondaryTypes) : album.artistName
    return MetaLine.join([who, year])
  }

  var body: some View {
    let byline = Self.byline(album, onArtistPage: onArtistPage)
    VStack(alignment: .leading, spacing: 10) {
      NavigationLink(value: DiscoverDestination.card(album).route) {
        VStack(alignment: .leading, spacing: 8) {
          Cover(path: album.coverUrl, points: width, label: album.title)
            .frame(width: width, height: width)
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
}
