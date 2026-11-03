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

/// How wide shelf cards are: about 42 % of a phone's width, at most 208 points (the web's `w-[42vw] max-w-52`).
enum ShelfCard {
  static let width: CGFloat = 160
  static let artistWidth: CGFloat = 150
}
