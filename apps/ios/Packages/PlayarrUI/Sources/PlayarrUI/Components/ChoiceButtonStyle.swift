import SwiftUI

/// One of a row of choices (docs/design.md, "Choices"), such as Stats' ranges: spaced mono capitals in a capsule
/// 32 points tall, 44 to tap. The chosen one is filled with paper and has a dark label; the others are outlined with
/// `line` and have a `muted` label. Put a row of them in a sideways `ScrollView`: on a phone it never wraps.
struct ChoiceButtonStyle: ButtonStyle {
  let selected: Bool

  func makeBody(configuration: Configuration) -> some View {
    ChoiceBody(configuration: configuration, selected: selected)
  }
}

extension ButtonStyle where Self == ChoiceButtonStyle {
  /// Also give the button `.accessibilityAddTraits(.isSelected)` when it's the chosen one.
  static func choice(selected: Bool) -> ChoiceButtonStyle { ChoiceButtonStyle(selected: selected) }
}

private struct ChoiceBody: View {
  let configuration: ButtonStyleConfiguration
  let selected: Bool
  @Environment(\.isEnabled) private var isEnabled
  @Environment(\.dynamicTypeSize) private var typeSize
  /// The letter spacing grows with the text, as `em` does on the web.
  @ScaledMetric(relativeTo: .caption2) private var scale: CGFloat = 1

  var body: some View {
    let accessibilitySize = typeSize.isAccessibilitySize
    configuration.label
      // Regular at the accessibility sizes, where a weight on the font reads to the audit as text that doesn't fully grow.
      .font(.mono(size: 11, relativeTo: .caption2, weight: accessibilitySize ? .regular : .medium))
      .textCase(.uppercase)
      // None at the accessibility sizes, where spaced capitals take too much room.
      .tracking(accessibilitySize ? 0 : 0.9 * scale)
      .lineLimit(1)
      .foregroundStyle(selected ? AnyShapeStyle(Color.black) : AnyShapeStyle(.muted))
      .padding(.horizontal, 14)
      .padding(.vertical, 4)
      .frame(minHeight: 32)
      .background {
        if selected {
          Capsule().fill(.paper)
        } else {
          Capsule().fill(Color.paper.opacity(configuration.isPressed ? 0.05 : 0))
          Capsule().strokeBorder(.line, lineWidth: 1)
        }
      }
      .opacity(isEnabled ? 1 : 0.4)
      .animation(Motion.fast, value: configuration.isPressed)
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(Rectangle())
  }
}
