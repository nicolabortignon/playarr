import PlayarrAPI
import SwiftUI

/// An artist from MusicBrainz or ListenBrainz: their library page when they're in it, else their discography. Drawn as
/// every artist card is (`ArtistTile`): the picture in a circle, the name below.
struct DiscoverArtistCard: View {
  let artist: DiscoverArtist
  var width: CGFloat = ShelfCard.width

  init(artist: DiscoverArtist, width: CGFloat = ShelfCard.width) {
    self.artist = artist
    self.width = width
  }

  private var detail: String { artist.artistId != nil ? "In your library" : (artist.disambiguation ?? artist.genres.first ?? "Artist") }

  var body: some View {
    NavigationLink(value: DiscoverDestination.card(artist).route) {
      ArtistTile(name: artist.name, imageUrl: artist.imageUrl, meta: detail, width: width)
    }
    .buttonStyle(.plain)
    .pointerHover()
    .accessibilityLabel("\(artist.name), \(detail)")
  }
}
