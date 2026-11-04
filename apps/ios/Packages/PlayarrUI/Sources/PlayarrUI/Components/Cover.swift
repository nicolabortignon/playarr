import PlayarrAPI
import SwiftUI

/// Album art or an artist photo, asked at the size it's shown (apps/web/src/components/Cover.tsx). Without one, a
/// record-label stand-in: grooves and initials.
struct Cover: View {
  let path: String?
  /// How wide it's shown, in points: picks the size asked for.
  let points: CGFloat
  /// Initials for the stand-in.
  var label = ""
  var circle = false
  var corner: CGFloat = 4

  @Environment(AccountSession.self) private var session
  @Environment(\.displayScale) private var scale
  @State private var image: Image?

  var body: some View {
    Color.clear
      .aspectRatio(1, contentMode: .fit)
      .overlay {
        if let image {
          image.resizable().scaledToFill()
        } else {
          CoverPlaceholder(label: label)
        }
      }
      .clipShape(circle ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: corner)))
      .task(id: "\(path ?? "")@\(points)") { await load() }
      .accessibilityHidden(true)
  }

  private func load() async {
    let size = ImageCache.pixels(points: points, scale: scale)
    guard let data = await session.images.data(path, size: size) else {
      image = nil
      return
    }
    image = Image.decoded(data)
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
    GeometryReader { geometry in
      let side = min(geometry.size.width, geometry.size.height)
      ZStack {
        Canvas { context, size in
          context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(white: 0.09)))
          let center = CGPoint(x: size.width / 2, y: size.height / 2)
          for radius in stride(from: CGFloat(3), to: max(size.width, size.height), by: 5) {
            let ring = Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
            context.stroke(ring, with: .color(Color(white: 0.12)), lineWidth: 2)
          }
        }
        Circle()
          .fill(theme.accent.color.opacity(0.9))
          .frame(width: side * 0.38, height: side * 0.38)
          .overlay {
            Text(initials).font(.display(size: max(8, side * 0.14))).foregroundStyle(.black)
          }
      }
    }
  }
}
