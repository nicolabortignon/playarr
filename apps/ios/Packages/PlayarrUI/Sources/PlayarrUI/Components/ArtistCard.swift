import PlayarrAPI
import SwiftUI

/// An artist: photo with the name over it and their counts (apps/web/src/components/Cards.tsx).
struct ArtistCard: View {
  let artist: Artist
  var width: CGFloat?

  @Environment(AccountSession.self) private var session

  var body: some View {
    NavigationLink(value: Route.artist(artist.id)) {
      Cover(path: artist.imageUrl, points: width ?? 170, label: artist.name)
        .aspectRatio(4 / 5, contentMode: .fill)
        .overlay {
          LinearGradient(colors: [.clear, .black.opacity(0.2), .black.opacity(0.95)], startPoint: .top, endPoint: .bottom)
        }
        .overlay(alignment: .bottomLeading) {
          VStack(alignment: .leading, spacing: 4) {
            Text(artist.name).font(.title3.weight(.semibold)).foregroundStyle(.white).lineLimit(2)
            Kicker(text: counts)
          }
          .padding(12)
        }
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .frame(width: width)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(artist.name), \(counts)")
    .accessibilityAddTraits(.isButton)
    .prefetch { session.prefetchArtist(artist.id) }
  }

  var counts: String { "\(Format.plural(artist.albumCount, "album")) · \(Format.plural(artist.trackCount, "track"))" }
}
