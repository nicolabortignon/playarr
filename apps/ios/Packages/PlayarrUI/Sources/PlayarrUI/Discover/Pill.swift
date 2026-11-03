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

  var body: some View {
    label
      .font(.system(size: small ? 10 : 11, weight: .medium, design: .monospaced))
      .textCase(.uppercase)
      .tracking(0.8)
      .lineLimit(1)
      .padding(.horizontal, small ? 10 : 14)
      .frame(height: small ? 28 : 32)
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
