import SwiftUI

/// Whether a detail page's own title has scrolled under the navigation bar (`titleInBar(_:)`).
@MainActor @Observable
final class BarTitle {
  /// Where the bar ends, in the window: the top of the page's safe area.
  var barBottom: CGFloat = 0
  /// The page's own title has gone under the bar, so the bar shows it.
  var shown = false
}

extension View {
  /// A detail page's name in the navigation bar, shown only once the page's own title (`DetailHeader`'s, marked with
  /// `scrollsUnderBar()`) has scrolled under the bar, so no screen shows the name twice (docs/design.md, "A title
  /// appears once per screen"). Tabs and lists use the system's large title, which does the same by itself.
  func titleInBar(_ title: String) -> some View {
    modifier(TitleInBar(title: title))
  }

  /// The page's own title, which hands the name to the bar once it has scrolled under it (`titleInBar(_:)`).
  func scrollsUnderBar() -> some View {
    modifier(ScrollsUnderBar())
  }
}

private struct TitleInBar: ViewModifier {
  let title: String
  @State private var state = BarTitle()

  func body(content: Content) -> some View {
    content
      .environment(state)
      // Where the bar ends: the top of the page's frame, which starts there even when the page runs up under the bar
      // (a scroll view, an artist's photo): what ignores the safe area is drawn past its frame, not laid out past it.
      .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { state.barBottom = $0 }
      .navigationTitle(title)
      .inlineTitle()
      .toolbar {
        ToolbarItem(placement: .principal) { BarTitleText(title: title, state: state) }
      }
  }
}

/// The bar's title, there once the page's own has gone. Until then the bar holds an empty stand-in, so the system draws
/// no title of its own there (the navigation title stays for the back button's menu); the words themselves aren't
/// drawn invisibly, which left them in the accessibility tree at 1:1 contrast and at a size the bar doesn't let grow.
private struct BarTitleText: View {
  let title: String
  let state: BarTitle

  var body: some View {
    ZStack {
      if state.shown {
        Text(title)
          .font(.sans(.headline))
          .lineLimit(1)
          .transition(.opacity)
      } else {
        Color.clear.frame(width: 1, height: 1).accessibilityHidden(true)
      }
    }
    .animation(Motion.fast, value: state.shown)
  }
}

private struct ScrollsUnderBar: ViewModifier {
  @Environment(BarTitle.self) private var state: BarTitle?

  func body(content: Content) -> some View {
    // Read here, so the check is made again if the bar moves (the phone turned).
    let barBottom = state?.barBottom ?? -.infinity
    content.onGeometryChange(for: Bool.self) { $0.frame(in: .global).maxY <= barBottom } action: { state?.shown = $0 }
  }
}
