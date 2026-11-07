import SwiftUI

/// Words that are part of a picture (a mix's cover, a stand-in cover's initials), drawn into it like the rest of
/// the artwork: they scale with the picture, not with the text size, and VoiceOver and the accessibility audit read
/// the card's own label instead. Lines are stacked from the bottom (or centred).
struct ArtworkText: View {
  let lines: [Text]
  var spacing: CGFloat = 2
  var centred = false

  var body: some View {
    // Drawn by a function outside the main actor, not a closure made here: SwiftUI can draw an animation's frames off
    // the main thread (iOS 26), and a closure made in `body` is the main actor's, which traps there (build 684).
    Canvas(renderer: Self.drawing(lines, spacing: spacing, centred: centred))
      .accessibilityHidden(true)
  }

  /// The lines, measured in the space there is and stacked from its bottom, or in its middle.
  nonisolated static func drawing(_ lines: [Text], spacing: CGFloat, centred: Bool) -> (inout GraphicsContext, CGSize) -> Void {
    { context, size in
      let resolved = lines.map { context.resolve($0) }
      let sizes = resolved.map { $0.measure(in: size) }
      let total = sizes.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, sizes.count - 1))
      var y = centred ? (size.height - total) / 2 : size.height - total
      for (line, measured) in zip(resolved, sizes) {
        let x = centred ? (size.width - measured.width) / 2 : 0
        context.draw(line, in: CGRect(x: x, y: y, width: centred ? measured.width : size.width, height: measured.height))
        y += measured.height + spacing
      }
    }
  }
}
