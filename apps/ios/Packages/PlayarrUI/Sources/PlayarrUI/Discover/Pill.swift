import SwiftUI

/// The web's small rounded, monospaced, upper-case control (Request buttons, Requests pill, Try again).
/// How a Pill is drawn: filled with the accent (asks for something), outlined (in progress), green (in the
/// library), red (failed), or quiet.
enum PillTone { case filled, outlined, done, warning, quiet }

struct Pill<Label: View>: View {
  var style: PillTone = .outlined
  var small = false
  /// 0–1: a download's share, drawn behind the label.
  var progress: Double?
  @ViewBuilder let label: Label

  /// The letter spacing grows with the text, as `em` does on the web.
  @ScaledMetric(relativeTo: .caption2) private var textScale: CGFloat = 1
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    label
      // Regular at the accessibility sizes, where a weight on the font reads to the audit as text that doesn't fully grow.
      .font(.mono(size: small ? 10 : 11, relativeTo: .caption2, weight: typeSize.isAccessibilitySize ? .regular : .medium))
      .textCase(.uppercase)
      .tracking(0.8 * textScale)
      .lineLimit(1)
      .padding(.horizontal, small ? 10 : 14)
      .frame(minHeight: small ? 28 : 32)
      .foregroundStyle(foreground)
      .background {
        ZStack(alignment: .leading) {
          if style == .filled { Capsule().fill(.tint) }
          if let progress {
            GeometryReader { box in
              Rectangle().fill(.tint.opacity(0.15)).frame(width: box.size.width * min(max(progress, 0), 1))
            }
            .clipShape(Capsule())
          }
          if style != .filled { Capsule().strokeBorder(border, lineWidth: 1) }
        }
      }
      .contentShape(Capsule())
  }

  private var foreground: AnyShapeStyle {
    switch style {
    case .filled: AnyShapeStyle(.background)
    case .outlined: AnyShapeStyle(.tint)
    case .done: AnyShapeStyle(.green)
    case .warning: AnyShapeStyle(.red)
    case .quiet: AnyShapeStyle(.secondary)
    }
  }

  private var border: AnyShapeStyle {
    switch style {
    case .filled, .outlined: AnyShapeStyle(.tint.opacity(0.4))
    case .done: AnyShapeStyle(.green.opacity(0.35))
    case .warning: AnyShapeStyle(.red.opacity(0.45))
    case .quiet: AnyShapeStyle(.separator)
    }
  }
}

/// Any button drawn as a `Pill`, the Request button's look, so the app's buttons share one face: `.buttonStyle(.pill())`
/// filled with the accent (Play, Try again), `.pill(.outlined)` beside it (Shuffle, New mix), `.pill(.quiet)` for
/// the lesser choice (Cancel). The pill is 32 points tall (28 small); the finger gets at least 44.
struct PillButtonStyle: ButtonStyle {
  var tone: PillTone = .filled
  var small = false

  func makeBody(configuration: Configuration) -> some View {
    PillButtonBody(configuration: configuration, tone: tone, small: small)
  }
}

private struct PillButtonBody: View {
  let configuration: ButtonStyleConfiguration
  let tone: PillTone
  let small: Bool
  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    Pill(style: tone, small: small) { configuration.label }
      .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
  }
}

extension ButtonStyle where Self == PillButtonStyle {
  static func pill(_ tone: PillTone = .filled, small: Bool = false) -> PillButtonStyle { PillButtonStyle(tone: tone, small: small) }
}
