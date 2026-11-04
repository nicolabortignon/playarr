import SwiftUI

/// A row that turns into a column at the accessibility text sizes (AX1 to AX5), so titles wrap instead of being
/// cut short beside a time, a button or a slider.
struct AdaptiveStack<Content: View>: View {
  var spacing: CGFloat?
  @ViewBuilder var content: () -> Content
  @Environment(\.dynamicTypeSize) private var size

  nonisolated static func stacks(at size: DynamicTypeSize) -> Bool { size.isAccessibilitySize }

  var body: some View {
    let layout = Self.stacks(at: size)
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: spacing))
      : AnyLayout(HStackLayout(spacing: spacing))
    layout(content)
  }
}

extension View {
  /// One line (or `lines`) at the usual sizes; at the accessibility sizes as many as it takes.
  func essentialLineLimit(_ lines: Int = 1) -> some View {
    modifier(EssentialLineLimit(lines: lines))
  }
}

private struct EssentialLineLimit: ViewModifier {
  let lines: Int
  @Environment(\.dynamicTypeSize) private var size

  func body(content: Content) -> some View {
    content.lineLimit(size.isAccessibilitySize ? nil : lines)
  }
}
