import PlayarrAPI
import SwiftUI

/// A mix on Home: up to four of its album covers under a wash of the mix's colour, "Made for you" and its title, then
/// a line about it (apps/web/src/components/Mixes.tsx).
struct MixCard: View {
  let mix: MixSummary
  var width: CGFloat = ShelfCard.width

  var body: some View {
    NavigationLink(value: Route.mix(mix.key)) {
      VStack(alignment: .leading, spacing: 6) {
        MixCover(mix: mix, width: width)
        Text(mix.subtitle).font(.subheadline).lineLimit(1)
        Text(Format.plural(mix.trackCount, "song")).font(.caption.monospaced()).foregroundStyle(.secondary)
      }
      .frame(width: width)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(mix.title), \(mix.subtitle), \(Format.plural(mix.trackCount, "song"))")
    .accessibilityAddTraits(.isButton)
  }
}

/// The mix's cover, drawn here rather than on the server.
struct MixCover: View {
  let mix: MixSummary
  let width: CGFloat

  var body: some View {
    let covers = mix.covers.count >= 4 ? Array(mix.covers.prefix(4)) : Array(mix.covers.prefix(1))
    // The web's `linear-gradient(165deg, …)`: mostly down, a little to the right.
    let wash = CSSGradient.points(angle: 165)
    ZStack(alignment: .bottomLeading) {
      OKLCH.rgb(l: 0.32, c: 0.09, h: mix.hue).color
      if covers.count == 4 {
        Grid(horizontalSpacing: 0, verticalSpacing: 0) {
          GridRow { cover(covers[0]); cover(covers[1]) }
          GridRow { cover(covers[2]); cover(covers[3]) }
        }
        .saturation(0.85)
      } else if let first = covers.first {
        Cover(path: first, points: width, corner: 0).saturation(0.85)
      }
      LinearGradient(
        stops: [
          .init(color: OKLCH.rgb(l: 0.62, c: 0.17, h: mix.hue).color.opacity(0.35), location: 0),
          .init(color: OKLCH.rgb(l: 0.42, c: 0.14, h: mix.hue).color.opacity(0.72), location: 0.45),
          .init(color: OKLCH.rgb(l: 0.2, c: 0.07, h: mix.hue).color.opacity(0.95), location: 1),
        ], startPoint: wash.start, endPoint: wash.end)
      VStack(alignment: .leading, spacing: 2) {
        Text("MADE FOR YOU").font(.system(size: width * 0.046, design: .monospaced)).tracking(2).foregroundStyle(.white.opacity(0.75))
        Text(mix.title).font(.system(size: width * 0.125, weight: .semibold, design: .serif)).foregroundStyle(.white).lineLimit(2)
      }
      .padding(width * 0.07)
    }
    .frame(width: width, height: width)
    .clipShape(RoundedRectangle(cornerRadius: 4))
  }

  private func cover(_ path: String) -> some View {
    Cover(path: path, points: width / 2, corner: 0)
  }
}
