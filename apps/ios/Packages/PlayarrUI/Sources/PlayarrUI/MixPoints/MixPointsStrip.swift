import PlayarrAPI
import SwiftUI

/// The whole song's energy per phrase with its bars underneath, the stretches either end where it overlaps its
/// neighbours shaded, the detected points as dashed lines, and the two markers to drag: In above the strip, Out below,
/// so they never collide. A drag snaps to bars; VoiceOver's swipe up and down moves a marker a bar.
struct MixPointsStrip: View {
  let editor: MixPointsEditor
  let phrases: [EnergyPicture.Phrase]
  let bars: [EnergyPicture.Bar]
  let onDrag: (MixPointsEditor.Point, Double) -> Void
  let onStep: (MixPointsEditor.Point, Bool) -> Void

  @Environment(Theme.self) private var theme

  private let handleRow: CGFloat = 44
  private let stripHeight: CGFloat = 64

  var body: some View {
    GeometryReader { box in
      let width = box.size.width
      let x = { (t: Double) in CGFloat(min(max(t, 0), editor.duration) / max(editor.duration, 1)) * width }
      ZStack(alignment: .topLeading) {
        Canvas { context, size in
          let top = handleRow
          let shown = editor.shown
          let shade = Color.primary.opacity(0.08)
          context.fill(Path(CGRect(x: 0, y: top, width: x(shown.mixIn), height: stripHeight)), with: .color(shade))
          context.fill(Path(CGRect(x: x(shown.mixOut), y: top, width: size.width - x(shown.mixOut), height: stripHeight)), with: .color(shade))
          for phrase in phrases {
            let h = max(2, CGFloat(EnergyPicture.heardHeight(phrase.energy)) * stripHeight)
            let rect = CGRect(x: phrase.left * size.width, y: top + stripHeight - h, width: max(1, phrase.width * size.width - 2), height: h)
            context.fill(Path(roundedRect: rect, cornerRadius: 3), with: .color(theme.accent.color))
          }
          for t in [editor.detected.mixIn, editor.detected.mixOut] {
            var line = Path()
            line.move(to: CGPoint(x: x(t), y: top))
            line.addLine(to: CGPoint(x: x(t), y: top + stripHeight))
            context.stroke(line, with: .color(.primary.opacity(0.45)), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
          }
          for bar in bars {
            let tick = CGRect(x: bar.left * size.width, y: top + stripHeight + 2, width: 1, height: bar.phrase ? 6 : 4)
            context.fill(Path(tick), with: .color(.primary.opacity(bar.phrase ? 0.4 : 0.15)))
          }
        }
        .accessibilityHidden(true)
        marker(.mixIn, label: "Mix in", handle: "In", x: x(editor.shown.mixIn), width: width)
        marker(.mixOut, label: "Mix out", handle: "Out", x: x(editor.shown.mixOut), width: width)
      }
    }
    .coordinateSpace(.named("strip"))
    .frame(height: handleRow * 2 + stripHeight + 8)
  }

  private func marker(_ point: MixPointsEditor.Point, label: String, handle: String, x: CGFloat, width: CGFloat) -> some View {
    let top = point == .mixIn
    return VStack(spacing: 0) {
      if top { handleView(handle) }
      Rectangle().fill(.primary).frame(width: 2, height: stripHeight + 8)
      if !top { handleView(handle) }
    }
    .frame(width: 44)
    .contentShape(Rectangle())
    .position(x: x, y: handleRow + (stripHeight + 8) / 2 + (top ? -handleRow / 2 : handleRow / 2))
    .gesture(
      DragGesture(minimumDistance: 0, coordinateSpace: .named("strip"))
        .onChanged { drag in onDrag(point, Double(drag.location.x / max(width, 1)) * editor.duration) }
    )
    .accessibilityElement()
    .accessibilityLabel(label)
    .accessibilityValue(Format.time(editor.time(point)))
    .accessibilityAdjustableAction { direction in
      switch direction {
      case .increment: onStep(point, true)
      case .decrement: onStep(point, false)
      @unknown default: break
      }
    }
  }

  private func handleView(_ text: String) -> some View {
    Text(text)
      .font(.mono(size: 10, weight: .medium)).textCase(.uppercase)
      .padding(.horizontal, 8).frame(minWidth: 40, minHeight: 24)
      .background(Capsule().fill(.primary))
      .foregroundStyle(.background)
      .frame(height: handleRow)
  }
}
