import SwiftUI

/// What a pill button is for (docs/design.md, "Controls").
enum PillVariant: Sendable {
  /// The one main action on a screen, filled with the accent: Play, Feeling lucky, Try again, Save.
  case primary
  /// Beside it, outlined: Shuffle, New mix, Cancel.
  case secondary
  /// A lesser action inside a panel: no outline, a quieter label.
  case ghost
  /// It destroys something, filled with red: Delete.
  case danger
}

/// How big a pill is drawn. Whatever the size, it takes at least 44 points of taps.
enum PillSize: Sendable {
  /// 48: a page's action row, Feeling lucky, an empty page's action.
  case large
  /// 40: dialogs, panels, error states.
  case regular
  /// 32: inside a card or a row, such as Request.
  case small

  var height: CGFloat {
    switch self {
    case .large: 48
    case .regular: 40
    case .small: 32
    }
  }

  var padding: CGFloat {
    switch self {
    case .large: 16
    case .regular: 14
    case .small: 10
    }
  }

  /// The icon's size, before Dynamic Type.
  var icon: CGFloat {
    switch self {
    case .large: 20
    case .regular: 18
    case .small: 16
    }
  }

  var spacing: CGFloat { self == .large ? 8 : 6 }

  /// Small pills set their words a size down, so a partly-here album's two fit under a 150-point card.
  var textStyle: Font.TextStyle { self == .small ? .footnote : .subheadline }
}

/// The app's one button: a capsule with its words in sentence case, an optional leading icon (`Label`), drawn as its
/// variant and size say (docs/design.md, "Controls"). Disabled, it fades to 40 %. Mono capitals are for choices
/// (`.choice(selected:)`) and statuses (`StatusBadge`), never for actions.
struct PillButtonStyle: ButtonStyle {
  var variant: PillVariant
  var size: PillSize

  func makeBody(configuration: Configuration) -> some View {
    PillBody(configuration: configuration, variant: variant, size: size)
  }
}

extension ButtonStyle where Self == PillButtonStyle {
  static func pill(_ variant: PillVariant, size: PillSize = .regular) -> PillButtonStyle {
    PillButtonStyle(variant: variant, size: size)
  }
}

private struct PillBody: View {
  let configuration: ButtonStyleConfiguration
  let variant: PillVariant
  let size: PillSize
  @Environment(\.isEnabled) private var isEnabled
  @Environment(\.dynamicTypeSize) private var typeSize
  /// Icons grow with the text, up to half as big again.
  @ScaledMetric(relativeTo: .subheadline) private var scale: CGFloat = 1

  var body: some View {
    let pressed = configuration.isPressed
    configuration.label
      .labelStyle(PillLabelStyle(spacing: size.spacing, iconSize: size.icon * min(scale, 1.5)))
      // Regular at the accessibility sizes, where a weight on the font reads to the audit as text that doesn't fully grow.
      .font(typeSize.isAccessibilitySize ? .sans(size.textStyle) : .sans(size.textStyle).weight(.medium))
      .essentialLineLimit()
      .multilineTextAlignment(.center)
      .foregroundStyle(foreground)
      .padding(.horizontal, size.padding)
      .padding(.vertical, 6)
      .frame(minHeight: size.height)
      .background {
        switch variant {
        case .primary: Capsule().fill(.tint).opacity(pressed ? 0.8 : 1)
        case .danger: Capsule().fill(.danger).opacity(pressed ? 0.8 : 1)
        case .secondary:
          Capsule().fill(Color.paper.opacity(pressed ? 0.05 : 0))
          Capsule().strokeBorder(Color.paper.opacity(pressed ? 0.35 : 0.15), lineWidth: 1)
        case .ghost: Capsule().fill(Color.paper.opacity(pressed ? 0.05 : 0))
        }
      }
      .background {
        // A large primary button (Play, Feeling lucky) glows with the accent (docs/design.md, "Glow"): the web's
        // shadow-glow, 0 10px 40px -12px.
        if variant == .primary, size == .large {
          Capsule().fill(.tint).padding(12).offset(y: 10).blur(radius: 20)
        }
      }
      .opacity(isEnabled ? 1 : 0.4)
      .animation(Motion.fast, value: pressed)
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(Rectangle())
  }

  private var foreground: AnyShapeStyle {
    switch variant {
    // The web's accent-ink and ink-950: near black on the fill.
    case .primary, .danger: AnyShapeStyle(Color.black)
    case .secondary: AnyShapeStyle(.paper)
    case .ghost: AnyShapeStyle(.paperDim)
    }
  }
}

/// The icon at its own size before the words, whatever their text style.
private struct PillLabelStyle: LabelStyle {
  let spacing: CGFloat
  let iconSize: CGFloat

  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: spacing) {
      configuration.icon.font(.sans(size: iconSize))
      configuration.title
    }
  }
}
