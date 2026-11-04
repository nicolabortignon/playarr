import PlayarrAPI
import SwiftUI

/// An artist: photo with the name over it and their counts (apps/web/src/components/Cards.tsx).
struct ArtistCard: View {
  let artist: Artist
  var width: CGFloat?

  @Environment(AccountSession.self) private var session

  var body: some View {
    NavigationLink(value: Route.artist(artist.id)) {
      // 4:5, as on the web: the (square) cover fills it, cropped at the sides, so the name sits below its middle.
      Color.clear
        .aspectRatio(4 / 5, contentMode: .fit)
        .overlay {
          GeometryReader { geometry in
            let side = geometry.size.height
            Cover(path: artist.imageUrl, points: (width ?? 170) * 1.25, label: artist.name)
              .frame(width: side, height: side)
              .position(x: geometry.size.width / 2, y: side / 2)
          }
        }
        .overlay {
          LinearGradient(colors: [.clear, .black.opacity(0.2), .black.opacity(0.95)], startPoint: .top, endPoint: .bottom)
        }
        .overlay(alignment: .bottomLeading) {
          VStack(alignment: .leading, spacing: 4) {
            Text(artist.name).font(.display(.title3)).foregroundStyle(.white).lineLimit(2)
            Kicker(text: counts, tracking: 0.55).lineLimit(1)
          }
          .padding(12)
        }
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .frame(width: width)
    }
    .buttonStyle(.plain)
    .pointerHover()
    .accessibilityLabel("\(artist.name), \(counts)")
    .accessibilityAddTraits(.isButton)
    .prefetch { session.prefetchArtist(artist.id) }
  }

  var counts: String { "\(Format.plural(artist.albumCount, "album")) · \(Format.plural(artist.trackCount, "track"))" }
}
