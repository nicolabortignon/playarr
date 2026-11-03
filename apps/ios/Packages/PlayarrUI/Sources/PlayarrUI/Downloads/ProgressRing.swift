import SwiftUI

/// A thin ring filling clockwise from the top (the web's progress circles).
struct ProgressRing: View {
  let fraction: Double
  var lineWidth: CGFloat = 2

  var body: some View {
    ZStack {
      Circle().stroke(.secondary.opacity(0.3), lineWidth: lineWidth)
      Circle()
        .trim(from: 0, to: max(0.001, min(1, fraction)))
        .stroke(.tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
        .rotationEffect(.degrees(-90))
        .animation(.easeOut(duration: 0.3), value: fraction)
    }
  }
}
