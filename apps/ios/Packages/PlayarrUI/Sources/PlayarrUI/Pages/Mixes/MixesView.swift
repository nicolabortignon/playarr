import PlayarrAPI
import SwiftUI

/// Made for you: every mix (apps/web/src/pages/Mixes.tsx). "Tune your mixes" (Settings → Mixes) comes with phase 9's
/// panel.
struct MixesView: View {
  let session: AccountSession

  var body: some View {
    let store = session.mixes
    ScrollView {
      if let mixes = store.mixes {
        if mixes.isEmpty {
          Text(
            "No mixes yet. They appear as you listen and as Playarr learns about your library’s songs (their genres, years and sound), which takes a little while after adding music."
          )
          .foregroundStyle(.secondary)
          .padding(20)
        } else {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: ShelfCard.width), spacing: 16, alignment: .top)], spacing: 24) {
            ForEach(mixes, id: \.key) { MixCard(mix: $0) }
          }
          .padding(20)
        }
      } else if let error = store.error {
        ErrorState(message: error) { await store.load() }
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: ShelfCard.width), spacing: 16)], spacing: 24) {
          ForEach(0..<8, id: \.self) { _ in Skeleton().frame(width: ShelfCard.width) }
        }
        .padding(20)
      }
    }
    .navigationTitle("Made for you")
    .task { await store.poll() }
    .refreshable { await store.load() }
  }
}
