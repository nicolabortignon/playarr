import PlayarrAPI
import SwiftUI

/// An artist from MusicBrainz or ListenBrainz: their library page when they're in it, else their discography.
struct DiscoverArtistCard: View {
  let artist: DiscoverArtist
  var width: CGFloat = ShelfCard.artistWidth

  init(artist: DiscoverArtist, width: CGFloat = ShelfCard.artistWidth) {
    self.artist = artist
    self.width = width
  }

  private var detail: String { artist.artistId != nil ? "In your library" : (artist.disambiguation ?? artist.genres.first ?? "Artist") }

  var body: some View {
    NavigationLink(value: DiscoverDestination.card(artist).route) {
      VStack(spacing: 8) {
        Cover(path: artist.imageUrl, points: width, label: artist.name, circle: true).frame(width: width, height: width)
        Text(artist.name).font(.subheadline).lineLimit(1)
        Text(detail.uppercased())
          .font(.system(size: 10, design: .monospaced)).tracking(1.5)
          .foregroundStyle(.secondary).lineLimit(1)
      }
      .frame(width: width)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(artist.name), \(detail)")
  }
}
