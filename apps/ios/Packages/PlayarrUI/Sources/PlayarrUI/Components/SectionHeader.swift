import SwiftUI

/// A section's small kicker, its title, and "See all" or a button (apps/web/src/components/Section.tsx).
struct SectionHeader<Action: View>: View {
  let title: String
  var kicker: String?
  var seeAll: Route?
  @ViewBuilder var action: () -> Action
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    // "See all" goes under the title at the accessibility sizes, rather than squeezing it into a column of words.
    let stacked = typeSize.isAccessibilitySize
    let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(alignment: .lastTextBaseline))
    layout {
      VStack(alignment: .leading, spacing: 2) {
        if let kicker { Kicker(text: kicker) }
        Text(title).font(.display(.title2)).accessibilityAddTraits(.isHeader)
      }
      if !stacked { Spacer() }
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
  /// The spacing grows with the text, as `em` does on the web.
  @ScaledMetric(relativeTo: .caption2) private var scale: CGFloat = 1
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    Text(text.uppercased())
      .font(.mono(.caption2))
      // None at the accessibility sizes, where the spaced letters would break "MADE FOR YOU" over two lines.
      .tracking(typeSize.isAccessibilitySize ? 0 : tracking * scale)
      .foregroundStyle(.muted)
      // Grows with the text size even where a row is tight (Now Playing's header), wrapping rather than squeezing.
      .fixedSize(horizontal: false, vertical: true)
  }
}
