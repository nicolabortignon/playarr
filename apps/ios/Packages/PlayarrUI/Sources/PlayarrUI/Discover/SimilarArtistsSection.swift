import PlayarrAPI
import SwiftUI

/// Artists like this one, from who real listeners play alongside them (ListenBrainz): those in the library, then the
/// others, opening their discography to request albums (components/SimilarArtists.tsx).
public struct SimilarArtistsSection: View {
  let mbid: String

  @Environment(DiscoverContext.self) private var context: DiscoverContext?
  @State private var artists: [DiscoverArtist]?
  @State private var failed = false

  public init(mbid: String) {
    self.mbid = mbid
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 28) {
      if failed {
        VStack(alignment: .leading, spacing: 0) {
          SectionHeader(title: "Similar artists", kicker: SimilarArtistGroups.kicker)
          Text(SimilarArtistGroups.failed).font(.sans(.subheadline)).foregroundStyle(.secondary).padding(.horizontal, 20)
        }
      } else if let artists {
        ForEach(SimilarArtistGroups.make(artists), id: \.title) { group in
          VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: group.title, kicker: SimilarArtistGroups.kicker)
            Shelf { ForEach(group.artists, id: \.mbid) { DiscoverArtistCard(artist: $0) } }
          }
        }
      } else {
        VStack(alignment: .leading, spacing: 0) {
          SectionHeader(title: "Similar artists", kicker: SimilarArtistGroups.kicker)
          Shelf { ForEach(0..<6, id: \.self) { _ in Circle().fill(Color.secondary.opacity(0.15)).frame(width: ShelfCard.width, height: ShelfCard.width) } }
        }
      }
    }
    .task(id: mbid) {
      do {
        artists = try await context?.similarArtists(mbid)
        failed = false
      } catch is CancellationError {
      } catch {
        failed = true
      }
    }
  }
}
