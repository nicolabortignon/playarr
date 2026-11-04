import SwiftUI

/// Play (filled with the accent) and Shuffle side by side, the same size: an artist's, a playlist's, a mix's and
/// Favorites' pages. Both labels take at least the width "Shuffle" needs, growing with Dynamic Type.
struct PlayShuffleButtons: View {
  /// What's played, for VoiceOver: "Play Mezzanine".
  let title: String
  var disabled = false
  let play: () -> Void
  let shuffle: () -> Void

  @Environment(Theme.self) private var theme
  @ScaledMetric(relativeTo: .body) private var labelWidth: CGFloat = 88

  var body: some View {
    HStack(spacing: 12) {
      Button(action: play) { Label("Play", systemImage: "play.fill").frame(minWidth: labelWidth) }
        .buttonStyle(.borderedProminent)
        .tint(theme.accent.color)
        .foregroundStyle(.black)
        .accessibilityLabel("Play \(title)")
      Button(action: shuffle) { Label("Shuffle", systemImage: "shuffle").frame(minWidth: labelWidth) }
        .buttonStyle(.bordered)
        .accessibilityLabel("Shuffle \(title)")
    }
    .labelStyle(.titleAndIcon)
    .buttonBorderShape(.capsule)
    .fixedSize()
    .disabled(disabled)
  }
}

/// A page's buttons in a row, carried on to the next line when they don't fit, rather than squeezed: each keeps the
/// size it asks for.
struct FlowRow: Layout {
  var spacing: CGFloat = 12
  var lineSpacing: CGFloat = 12

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    arrange(subviews, width: proposal.width ?? .infinity).size
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let arrangement = arrange(subviews, width: bounds.width)
    for (view, frame) in zip(subviews, arrangement.frames) {
      view.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.midY), anchor: .leading, proposal: ProposedViewSize(frame.size))
    }
  }

  /// Each view's frame, lines filled left to right and their views centred on the line.
  private func arrange(_ subviews: Subviews, width: CGFloat) -> (frames: [CGRect], size: CGSize) {
    var lines: [[(index: Int, size: CGSize)]] = [[]]
    var x: CGFloat = 0
    for (index, view) in subviews.enumerated() {
      let size = view.sizeThatFits(.unspecified)
      if x > 0, x + size.width > width {
        lines.append([])
        x = 0
      }
      lines[lines.count - 1].append((index, size))
      x += size.width + spacing
    }
    var frames = Array(repeating: CGRect.zero, count: subviews.count)
    var y: CGFloat = 0
    var widest: CGFloat = 0
    for line in lines where !line.isEmpty {
      let height = line.map(\.size.height).max() ?? 0
      var x: CGFloat = 0
      for item in line {
        frames[item.index] = CGRect(x: x, y: y + (height - item.size.height) / 2, width: item.size.width, height: item.size.height)
        x += item.size.width + spacing
      }
      widest = max(widest, x - spacing)
      y += height + lineSpacing
    }
    return (frames, CGSize(width: widest, height: max(0, y - lineSpacing)))
  }
}
