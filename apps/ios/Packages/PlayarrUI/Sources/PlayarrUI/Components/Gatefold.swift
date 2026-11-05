import SwiftUI

/// A page led by its artwork (an album, a playlist, a mix), on an iPhone held sideways: it opens like Now Playing's
/// sleeve, the artwork staying on the leading side as large as the height allows while the rest of the page scrolls
/// beside it. Upright (and on an iPad) the same pages are one column with the artwork at its head;
/// `GatefoldRule.applies` says which.
struct Gatefold<Art: View, Page: View>: View {
  /// The artwork, given the side it's drawn at.
  @ViewBuilder let art: (CGFloat) -> Art
  @ViewBuilder let page: Page

  var body: some View {
    GeometryReader { geometry in
      let side = GatefoldRule.artSide(width: geometry.size.width, height: geometry.size.height)
      HStack(alignment: .center, spacing: 24) {
        art(side).frame(width: side, height: side)
        page.frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      .padding(.leading, 20)
    }
  }
}

enum GatefoldRule {
  /// Pages open as a gatefold on an iPhone held sideways, where the height is compact.
  static func applies(_ verticalSizeClass: UserInterfaceSizeClass?) -> Bool { verticalSizeClass == .compact }

  /// The artwork's side: the page's height less a margin above and below, at most 40 % of its width.
  static func artSide(width: CGFloat, height: CGFloat) -> CGFloat {
    max(0, min(height - 32, width * 0.4))
  }
}
