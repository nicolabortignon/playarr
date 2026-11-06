import SwiftUI

/// A row that scrolls sideways and stops on a card (apps/web/src/components/Section.tsx `Shelf`).
struct Shelf<Content: View>: View {
  @ViewBuilder var content: () -> Content

  var body: some View {
    ScrollView(.horizontal) {
      LazyHStack(alignment: .top, spacing: 16) { content() }
        .scrollTargetLayout()
    }
    .scrollTargetBehavior(.viewAligned)
    .contentMargins(.horizontal, 20, for: .scrollContent)
    .scrollIndicators(.hidden)
  }
}

/// How wide every card on a shelf is, albums, playlists, mixes and artists alike (docs/design.md, "Cards"; the web's
/// `SHELF_CARD`): about 42 % of a phone's width.
enum ShelfCard {
  static let width: CGFloat = 160
}
