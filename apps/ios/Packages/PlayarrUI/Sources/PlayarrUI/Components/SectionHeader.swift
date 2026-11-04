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
        Text(title).font(.display(.title2)).accessibilityAddTraits(.isHeader)
      }
      Spacer()
      action()
      if let seeAll {
        NavigationLink(value: seeAll) { Kicker(text: "See all").frame(minHeight: 44).contentShape(Rectangle()) }
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
  /// The web's `tracking-[0.2em]`; counts under a name use `tracking-wider` (0.55).
  var tracking: CGFloat = 2

  var body: some View {
    Text(text.uppercased())
      .font(.mono(.caption2))
      .tracking(tracking)
      .foregroundStyle(.muted)
  }
}
