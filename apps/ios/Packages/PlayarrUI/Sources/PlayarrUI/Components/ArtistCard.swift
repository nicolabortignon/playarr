import PlayarrAPI
import SwiftUI

/// An artist on a shelf or in a grid (apps/web/src/components/Cards.tsx `ArtistCard`): their picture in a circle, the
/// name below it as on album cards, and their counts.
struct ArtistCard: View {
  let artist: Artist
  var width: CGFloat?

  @Environment(AccountSession.self) private var session

  var body: some View {
    NavigationLink(value: Route.artist(artist.id)) {
      ArtistTile(name: artist.name, imageUrl: artist.imageUrl, meta: counts, width: width)
    }
    .buttonStyle(.plain)
    .pointerHover()
    .accessibilityLabel("\(artist.name), \(counts)")
    .accessibilityAddTraits(.isButton)
    .prefetch { session.prefetchArtist(artist.id) }
  }

  var counts: String { "\(Format.plural(artist.albumCount, "album")) · \(Format.plural(artist.trackCount, "song"))" }
}

/// How an artist looks on a card, in or out of the library (docs/design.md, "Cards"): their photo, else their best album
/// cover (the server's pick when there's no photo), else a vinyl monogram of their initials, in a circle; the name below
/// it, then a line about them ("4 albums · 41 songs", "In your library").
struct ArtistTile: View {
  let name: String
  let imageUrl: String?
  var meta: String?
  /// Its width on a shelf; nil fills its grid column.
  var width: CGFloat?

  var body: some View {
    VStack(spacing: 6) {
      Cover(path: imageUrl, points: width ?? 180, label: name, circle: true)
        .overlay(Circle().strokeBorder(Color.paper.opacity(0.1)))
        .coverShadow(.shelf)
      VStack(spacing: 2) {
        Text(name).typeRole(.body).foregroundStyle(.paper).essentialLineLimit()
        if let meta { Text(meta).typeRole(.small).foregroundStyle(.paperDim).essentialLineLimit() }
      }
      .multilineTextAlignment(.center)
      .padding(.top, 4)
    }
    .frame(width: width)
    .frame(maxWidth: width == nil ? .infinity : nil)
    .contentShape(Rectangle())
  }
}
