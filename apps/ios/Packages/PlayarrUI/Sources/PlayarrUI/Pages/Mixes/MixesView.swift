import PlayarrAPI
import SwiftUI

/// Made for you: every mix, and where to tune them (apps/web/src/pages/Mixes.tsx).
struct MixesView: View {
  let session: AccountSession

  var body: some View {
    let store = session.mixes
    ScrollView {
      if let mixes = store.mixes {
        if mixes.isEmpty {
          EmptyState(systemImage: "sparkles", line: PageLines.mixes, fill: .lucky)
        } else {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: ShelfCard.width), spacing: 16, alignment: .top)], spacing: 24) {
            ForEach(mixes, id: \.key) { MixCard(mix: $0) }
          }
          .padding(20)
        }
      } else if let error = store.error {
        ErrorState(message: error) { await store.load() }
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: ShelfCard.width), spacing: 16, alignment: .top)], spacing: 24) {
          CardSkeletons(width: ShelfCard.width)
        }
        .padding(20)
      }
    }
    .pageHeader("Made for you", count: store.mixes.map { Format.plural($0.count, "mix", "mixes") })
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button { session.router.open(.settingsPanel(.mixes)) } label: {
          Label("Tune your mixes", systemImage: "slider.horizontal.3")
        }
      }
    }
    .task { await store.poll() }
    .refreshable { await store.load() }
  }
}
