import SwiftUI

/// On the iPhone Duo's cover screen the status bar, the bar buttons and the tabs stand in a column down the right. The
/// page runs under it, as a phone's runs under its tab bar, but only its backgrounds (a wash, a photo, a blurred cover):
/// the column covers most of the screen's height, so rows, words and buttons keep clear of it, as they would of a
/// phone's edges. Told apart by the screen being upright with a margin on its right: an iPhone only keeps one on its
/// sides when it's turned.
struct UnderTheRail: ViewModifier {
  /// The column's width, on the Duo's cover screen; 0 everywhere else.
  @State private var rail: CGFloat = 0

  func body(content: Content) -> some View {
    ZStack {
      Color.clear
        .ignoresSafeArea()
        .onGeometryChange(for: CGFloat.self) { Self.railWidth(size: $0.size, trailingInset: $0.safeAreaInsets.trailing) } action: {
          rail = $0
        }
      content
        // The page's content keeps the column's width clear, as safe area: scroll views inset what they scroll,
        // and what ignores the safe area (backgrounds) still runs under the column.
        .safeAreaPadding(.trailing, rail)
        .ignoresSafeArea(.container, edges: rail > 0 ? .trailing : [])
        .environment(\.underTheRail, rail > 0)
    }
  }

  /// The column's width: the window's trailing margin, when it's upright.
  static func railWidth(size: CGSize, trailingInset: CGFloat) -> CGFloat {
    size.height > size.width ? trailingInset : 0
  }
}

extension EnvironmentValues {
  /// The page runs under the iPhone Duo's column of status and buttons (`UnderTheRail`): a page with buttons of its
  /// own at the top hands them to the bar, which iOS stacks in that column.
  @Entry var underTheRail = false
}

extension View {
  /// Lets the page's backgrounds run under the Duo's column of status and buttons on its cover screen, keeping its
  /// content clear of it (`UnderTheRail`).
  func underTheRail() -> some View { modifier(UnderTheRail()) }
}
