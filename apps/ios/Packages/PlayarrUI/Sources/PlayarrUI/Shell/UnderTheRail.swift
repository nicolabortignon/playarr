import SwiftUI

/// On the iPhone Duo's cover screen the status bar, the bar buttons and the tabs stand in a column down the right,
/// which iOS keeps pages clear of. Pages run under it instead, as a phone's run under its tab bar. Told apart by the
/// screen being upright with a margin on its right: an iPhone only keeps one on its sides when it's turned.
struct UnderTheRail: ViewModifier {
  @State private var rail = false

  func body(content: Content) -> some View {
    ZStack {
      Color.clear
        .ignoresSafeArea()
        .onGeometryChange(for: Bool.self) { $0.size.height > $0.size.width && $0.safeAreaInsets.trailing > 0 } action: { rail = $0 }
      content.ignoresSafeArea(.container, edges: rail ? .trailing : [])
    }
  }
}

extension View {
  /// Runs under the Duo's column of status and buttons on its cover screen (`UnderTheRail`).
  func underTheRail() -> some View { modifier(UnderTheRail()) }
}
