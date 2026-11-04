import PlayarrAPI
import SwiftUI

/// A mix on Home: its cover (a wash of its colour, its album covers as circles, "Made for you" and its title), then a
/// line about it (apps/web/src/components/Mixes.tsx).
struct MixCard: View {
  let mix: MixSummary
  var width: CGFloat = ShelfCard.width

  var body: some View {
    NavigationLink(value: Route.mix(mix.key)) {
      VStack(alignment: .leading, spacing: 6) {
        MixCover(mix: mix, width: width)
        Text(mix.subtitle).font(.sans(.subheadline)).lineLimit(1)
        Text(Format.plural(mix.trackCount, "song")).font(.mono(.caption)).foregroundStyle(.secondary)
      }
      .frame(width: width)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(mix.title), \(mix.subtitle), \(Format.plural(mix.trackCount, "song"))")
    .accessibilityAddTraits(.isButton)
  }
}

/// The mix's cover, drawn here rather than on the server: a wash of the mix's colour, one of its album covers as a big
/// circle off the top right with a thin ring round it, up to three more as small circles on the ring (tinted towards
/// the mix's colour), and its name. Where the circles go comes from the mix's key (MixOrbit), as on the web.
struct MixCover: View {
  let mix: MixSummary
  let width: CGFloat

  var body: some View {
    let covers = Array(mix.covers.prefix(4))
    let layout = MixOrbit.layout(key: mix.key, covers: covers.count)
    // The web's `linear-gradient(165deg, …)`: mostly down, a little to the right.
    let wash = CSSGradient.points(angle: 165)
    ZStack(alignment: .bottomLeading) {
      LinearGradient(
        stops: [
          .init(color: tone(0.5, 0.15), location: 0),
          .init(color: tone(0.34, 0.11), location: 0.45),
          .init(color: tone(0.18, 0.06), location: 1),
        ], startPoint: wash.start, endPoint: wash.end)
      ZStack(alignment: .topLeading) {
        Circle().strokeBorder(.white.opacity(0.15), lineWidth: 1)
          .place(MixOrbit.Circle(x: layout.hero.x, y: layout.hero.y, d: layout.ring * 2), in: width)
        if let first = covers.first {
          circle(Cover(path: first, points: width * layout.hero.d, corner: 0).saturation(0.9))
            .shadow(color: .black.opacity(0.55), radius: width * 0.06, y: width * 0.05)
            .place(layout.hero, in: width)
        } else {
          record.place(layout.hero, in: width)
        }
        ForEach(Array(zip(layout.satellites.indices, layout.satellites)), id: \.0) { i, c in
          circle(
            Cover(path: covers[i + 1], points: width * c.d, corner: 0)
              .saturation(0.6)
              .overlay(Rectangle().fill(tone(0.62, 0.14)).opacity(0.5).blendMode(.color))
          )
          .shadow(color: .black.opacity(0.5), radius: width * 0.03, y: width * 0.02)
          .place(c, in: width)
        }
        if let dot = layout.dot {
          Circle().fill(tone(0.78, 0.13)).place(dot, in: width)
        }
      }
      .frame(width: width, height: width, alignment: .topLeading)
      VStack(alignment: .leading, spacing: 2) {
        Text("MADE FOR YOU").font(.mono(size: width * 0.046)).tracking(2).foregroundStyle(.white.opacity(0.75))
        Text(mix.title).font(.display(size: width * 0.125)).foregroundStyle(.white).lineLimit(2)
          .shadow(color: .black.opacity(0.4), radius: 6, y: 2)
      }
      .padding(width * 0.07)
    }
    .frame(width: width, height: width)
    .clipShape(RoundedRectangle(cornerRadius: 4))
  }

  private func tone(_ l: Double, _ c: Double) -> Color { OKLCH.rgb(l: l, c: c, h: mix.hue).color }

  private func circle(_ content: some View) -> some View {
    content.clipShape(Circle()).overlay(Circle().strokeBorder(.white.opacity(0.1), lineWidth: 1))
  }

  /// Nothing to show yet: a record's grooves round the label, in the mix's colour.
  private var record: some View {
    ZStack {
      Circle().fill(tone(0.17, 0.04))
      ForEach(1..<8) { i in
        Circle().strokeBorder(tone(0.22, 0.05), lineWidth: 1).padding(width * groove(i))
      }
      Circle().fill(tone(0.72, 0.14)).padding(width * MixOrbit.hero * 0.33)
    }
  }

  /// How far in from the record's edge a groove is.
  private func groove(_ i: Int) -> CGFloat { MixOrbit.hero * 0.04 * CGFloat(i) }
}

private extension View {
  /// Sizes and places a view on a mix cover `width` across, by a circle in fractions of the side.
  func place(_ c: MixOrbit.Circle, in width: CGFloat) -> some View {
    frame(width: c.d * width, height: c.d * width)
      .position(x: c.x * width, y: c.y * width)
  }
}
