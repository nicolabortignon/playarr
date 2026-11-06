import PlayarrAPI
import SwiftUI

/// Artists like this one, from who real listeners play alongside them (ListenBrainz): those in the library, then the
/// others, opening their discography to request albums (components/SimilarArtists.tsx).
public struct SimilarArtistsSection: View {
  let mbid: String

  @Environment(DiscoverContext.self) private var context: DiscoverContext?
  @State private var artists: [DiscoverArtist]?
  @State private var failed = false
  /// Bumped by Try again.
  @State private var attempt = 0

  public init(mbid: String) {
    self.mbid = mbid
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 28) {
      if failed {
        VStack(alignment: .leading, spacing: 0) {
          SectionHeader(title: "Similar artists", kicker: SimilarArtistGroups.kicker)
          InlineError(SimilarArtistGroups.failed) { attempt += 1 }.padding(.horizontal, 20)
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
          Shelf { CardSkeletons(count: 6, round: true, width: ShelfCard.width) }
        }
      }
    }
    .task(id: "\(mbid) \(attempt)") {
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
