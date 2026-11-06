import SwiftUI

/// An icon in a 48-point circle outlined like a secondary pill (docs/design.md, "Icon buttons"): an action row's
/// Download and ⋯, and Shuffle or the page's own action once the row has no room for their words. Always give the
/// button an accessibility label.
struct OutlinedIconButtonStyle: ButtonStyle {
  /// 0–1, drawn over the outline in the accent from the top (a download as its songs arrive).
  var progress: Double?

  func makeBody(configuration: Configuration) -> some View {
    OutlinedIcon(pressed: configuration.isPressed, progress: progress) { configuration.label }
  }
}

extension ButtonStyle where Self == OutlinedIconButtonStyle {
  static var outlinedIcon: OutlinedIconButtonStyle { OutlinedIconButtonStyle() }

  static func outlinedIcon(progress: Double?) -> OutlinedIconButtonStyle { OutlinedIconButtonStyle(progress: progress) }
}

/// How an outlined icon button looks, also for what isn't a `Button`: a menu's label, a status in an action row.
struct OutlinedIcon<Content: View>: View {
  var pressed = false
  var progress: Double?
  @ViewBuilder let content: Content
  @Environment(\.isEnabled) private var isEnabled
  /// The icon and the circle grow with the text, up to half as big again.
  @ScaledMetric(relativeTo: .subheadline) private var scale: CGFloat = 1

  var body: some View {
    let grown = min(scale, 1.5)
    content
      .font(.sans(size: 20 * grown))
      .foregroundStyle(.paper)
      .frame(width: 48 * grown, height: 48 * grown)
      .background {
        Circle().fill(Color.paper.opacity(pressed ? 0.05 : 0))
        Circle().strokeBorder(Color.paper.opacity(pressed ? 0.35 : 0.15), lineWidth: 1)
        if let progress {
          Circle()
            .inset(by: 1)
            .trim(from: 0, to: max(0.001, min(1, progress)))
            .stroke(.tint, style: StrokeStyle(lineWidth: 2, lineCap: .round))
            .rotationEffect(.degrees(-90))
            .animation(.easeOut(duration: 0.3), value: progress)
        }
      }
      .contentShape(Circle())
      .opacity(isEnabled ? 1 : 0.4)
      .animation(Motion.fast, value: pressed)
  }
}
