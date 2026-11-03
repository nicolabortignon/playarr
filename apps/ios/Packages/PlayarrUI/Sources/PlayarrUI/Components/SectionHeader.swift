import SwiftUI

/// A section's small kicker, its title, and "See all" or a button (apps/web/src/components/Section.tsx).
struct SectionHeader<Action: View>: View {
  let title: String
  var kicker: String?
  var seeAll: Route?
  @ViewBuilder var action: () -> Action

  var body: some View {
    HStack(alignment: .lastTextBaseline) {
      VStack(alignment: .leading, spacing: 2) {
        if let kicker { Kicker(text: kicker) }
        Text(title).font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
      }
      Spacer()
      action()
      if let seeAll {
        NavigationLink(value: seeAll) { Kicker(text: "See all") }
          .accessibilityLabel("See all \(title)")
      }
    }
    .padding(.horizontal, 20)
    .padding(.bottom, 8)
  }
}

extension SectionHeader where Action == EmptyView {
  init(title: String, kicker: String? = nil, seeAll: Route? = nil) {
    self.init(title: title, kicker: kicker, seeAll: seeAll) { EmptyView() }
  }
}

/// The small, spaced, upper-case line above titles.
struct Kicker: View {
  let text: String

  var body: some View {
    Text(text.uppercased())
      .font(.caption2.monospaced())
      .tracking(2)
      .foregroundStyle(.secondary)
  }
}
