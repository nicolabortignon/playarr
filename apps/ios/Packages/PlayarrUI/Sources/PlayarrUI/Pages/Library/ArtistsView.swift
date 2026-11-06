import PlayarrAPI
import SwiftUI

/// Every artist (apps/web/src/pages/Artists.tsx).
struct ArtistsView: View {
  @State private var artists: Query<[Artist]>

  init(session: AccountSession) {
    let api = session.api
    _artists = State(initialValue: Query(.artists, cache: session.queries) { try await api.send(API.Library.artists()) })
  }

  var body: some View {
    ScrollView {
      if let error = artists.error {
        ErrorState(message: error) { await artists.refresh() }
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 16)], spacing: 16) {
          if let all = artists.value {
            ForEach(all) { ArtistCard(artist: $0) }
          } else {
            ForEach(0..<8, id: \.self) { _ in Skeleton(aspectRatio: 4 / 5) }
          }
        }
        .padding(20)
      }
    }
    .pageHeader("Artists", count: artists.value.map { Format.plural($0.count, "artist") })
    .task { await artists.load() }
    .refreshable { await artists.refresh() }
  }
}
