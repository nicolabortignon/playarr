import PlayarrAPI
import SwiftUI

/// Album art or an artist photo, asked at the size it's shown (apps/web/src/components/Cover.tsx). Until it comes, the
/// album's own color (`coverColor`, docs/design.md, Moments) where the server has read it; without art, or before it
/// comes where there's no color, a record-label stand-in: grooves and initials.
struct Cover: View {
  let path: String?
  /// How wide it's shown, in points: picks the size asked for.
  let points: CGFloat
  /// Initials for the stand-in.
  var label = ""
  /// The cover's own color (`coverColor`, `#rrggbb`), filling its space while the picture loads.
  var color: String?
  var circle = false
  var corner: CGFloat = 4

  @Environment(AccountSession.self) private var session
  @Environment(\.displayScale) private var scale
  @State private var image: Image?
  /// The picture asked for last couldn't be had: the stand-in, not the color, until another one comes.
  @State private var missing = false

  var body: some View {
    Color.clear
      .aspectRatio(1, contentMode: .fit)
      .overlay {
        if let image {
          image.resizable().scaledToFill()
        } else if path != nil, !missing, let loading = RGB(css: color) {
          loading.color
        } else {
          CoverPlaceholder(label: label)
        }
      }
      .clipShape(circle ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: corner)))
      .task(id: "\(path ?? "")@\(points)") { await load() }
      .accessibilityHidden(true)
  }

  private func load() async {
    missing = false
    let size = ImageCache.pixels(points: points, scale: scale)
    let url = session.images.url(path, size: size)
    // Already decoded: at once, with no trip off the main thread.
    if let ready = PreparedImages.shared.image(for: url) {
      image = ready
      return
    }
    guard let data = await session.images.data(path, size: size) else {
      image = nil
      missing = true
      return
    }
    image = await PreparedImages.shared.prepare(data, for: url)
    missing = false
  }
}

/// A record label: concentric grooves and the first letters of the name in the accent colour.
struct CoverPlaceholder: View {
  let label: String
  @Environment(Theme.self) private var theme

  var initials: String {
    label.split(separator: " ").prefix(2).compactMap { $0.first.map { String($0).uppercased() } }.joined()
  }

  var body: some View {
    // Drawn by a function outside the main actor, not a closure made here: SwiftUI can draw an animation's frames off
    // the main thread (iOS 26), and a closure made in `body` is the main actor's, which traps there (build 684).
    // Covers grow into Now Playing and into their album's page.
    Canvas(renderer: Self.drawing(initials: initials, accent: theme.accent.color))
  }

  /// The grooves, then the label: a disc of the accent 38 % of the side, the initials on it in the display face at 14 %.
  nonisolated static func drawing(initials: String, accent: Color) -> (inout GraphicsContext, CGSize) -> Void {
    { context, size in
      context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(white: 0.09)))
      let center = CGPoint(x: size.width / 2, y: size.height / 2)
      for radius in stride(from: CGFloat(3), to: max(size.width, size.height), by: 5) {
        let ring = Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
        context.stroke(ring, with: .color(Color(white: 0.12)), lineWidth: 2)
      }
      let side = min(size.width, size.height)
      let disc = side * 0.38
      context.fill(Path(ellipseIn: CGRect(x: center.x - disc / 2, y: center.y - disc / 2, width: disc, height: disc)), with: .color(accent.opacity(0.9)))
      context.draw(context.resolve(Text(initials).font(.display(size: max(8, side * 0.14))).foregroundStyle(.black)), at: center, anchor: .center)
    }
  }
}
