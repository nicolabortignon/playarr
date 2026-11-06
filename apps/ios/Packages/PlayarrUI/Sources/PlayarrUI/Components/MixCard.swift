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
        Text(mix.subtitle).font(.sans(.subheadline)).essentialLineLimit()
        Text(Format.plural(mix.trackCount, "song")).font(.mono(.caption)).foregroundStyle(.paperDim)
      }
      .frame(width: width)
    }
    .buttonStyle(.plain)
    .pointerHover()
    .accessibilityLabel("\(mix.title), \(mix.subtitle), \(Format.plural(mix.trackCount, "song"))")
    .accessibilityAddTraits(.isButton)
  }
}

/// The mix's cover, drawn here rather than on the server: a wash of the mix's colour (for Vibes, Discovery and On
/// Repeat, running between the colours of its first two covers, faded in once they're read), one of its album covers as
/// a big circle off the top right with a thin ring round it, up to three more as small circles on the ring (tinted
/// towards the mix's colour), and its name. Where the circles go comes from the mix's key (MixOrbit), as on the web.
struct MixCover: View {
  let mix: MixSummary
  let width: CGFloat

  @Environment(Theme.self) private var theme
  @Environment(AccountSession.self) private var session
  /// The hues of the covers the wash comes from, once read, with which covers they were.
  @State private var read: (key: [String], hues: [Double?])?

  var body: some View {
    let covers = Array(mix.covers.prefix(4))
    let layout = MixOrbit.layout(key: mix.key, covers: covers.count)
    let base = MixOrbit.wash(from: mix.hue)
    let toned = tones.map { MixOrbit.wash(from: $0.from, to: $0.to) }
    // The small circles, the dot and the record take the middle of the wash.
    let hue = (toned ?? base)[2].h
    ZStack(alignment: .bottomLeading) {
      gradient(base)
      gradient(toned ?? base).opacity(toned == nil ? 0 : 1)
      ZStack(alignment: .topLeading) {
        Circle().strokeBorder(.white.opacity(0.15), lineWidth: 1)
          .place(MixOrbit.Circle(x: layout.hero.x, y: layout.hero.y, d: layout.ring * 2), in: width)
        if let first = covers.first {
          circle(Cover(path: first, points: width * layout.hero.d, corner: 0).saturation(0.9))
            .shadow(color: .black.opacity(0.55), radius: width * 0.06, y: width * 0.05)
            .place(layout.hero, in: width)
        } else {
          record(hue).place(layout.hero, in: width)
        }
        ForEach(Array(zip(layout.satellites.indices, layout.satellites)), id: \.0) { i, c in
          circle(
            Cover(path: covers[i + 1], points: width * c.d, corner: 0)
              .saturation(0.6)
              .overlay(Rectangle().fill(tone(0.62, 0.14, hue)).opacity(0.5).blendMode(.color))
          )
          .shadow(color: .black.opacity(0.5), radius: width * 0.03, y: width * 0.02)
          .place(c, in: width)
        }
        if let dot = layout.dot {
          Circle().fill(tone(0.78, 0.13, hue)).place(dot, in: width)
        }
      }
      .frame(width: width, height: width, alignment: .topLeading)
      // Part of the picture: it scales with the cover, and the card's own label is what VoiceOver reads.
      ArtworkText(lines: [
        Text("MADE FOR YOU").font(.mono(size: width * 0.046)).tracking(2).foregroundStyle(.white.opacity(0.75)),
        Text(mix.title).font(.display(size: width * 0.125)).foregroundStyle(.white),
      ])
      .shadow(color: .black.opacity(0.4), radius: 6, y: 2)
      .padding(width * 0.07)
    }
    .frame(width: width, height: width)
    .clipShape(RoundedRectangle(cornerRadius: 4))
    .task(id: tonePaths) { await readTones() }
  }

  /// The covers the wash comes from: the first two, for Vibes, Discovery and On Repeat.
  private var tonePaths: [String] {
    MixOrbit.toneFromCovers(mix.kind) ? Array(mix.covers.prefix(2)) : []
  }

  /// The two hues of the wash, from the covers (the first's alone when the second has none); nil until they're read, or
  /// when neither has a colour to give. Covers read already (by another card, or the player) show at once.
  private var tones: (from: Double, to: Double)? {
    let paths = tonePaths
    guard !paths.isEmpty else { return nil }
    let hues: [Double?]
    if let read, read.key == paths {
      hues = read.hues
    } else {
      let known = paths.map { theme.knownAccent(of: $0) }
      guard known.allSatisfy({ $0 != nil }) else { return nil }
      hues = known.map { $0!.map(OKLCH.hue(of:)) }
    }
    let second = hues.count > 1 ? hues[1] : nil
    guard let from = hues[0] ?? second else { return nil }
    return (from, second ?? from)
  }

  private func readTones() async {
    let paths = tonePaths
    guard !paths.isEmpty else { return }
    var hues: [Double?] = []
    for path in paths {
      hues.append(await theme.accent(of: path, images: session.images).map(OKLCH.hue(of:)))
    }
    withAnimation(.easeOut(duration: 0.7)) { read = (paths, hues) }
  }

  /// The web's `linear-gradient(165deg, …)` of a wash: mostly down, a little to the right.
  private func gradient(_ stops: [MixOrbit.WashStop]) -> some View {
    let points = CSSGradient.points(angle: 165)
    return LinearGradient(
      stops: stops.map { .init(color: OKLCH.rgb(l: $0.l, c: $0.c, h: $0.h).color, location: $0.at) },
      startPoint: points.start, endPoint: points.end)
  }

  private func tone(_ l: Double, _ c: Double, _ h: Double) -> Color { OKLCH.rgb(l: l, c: c, h: h).color }

  private func circle(_ content: some View) -> some View {
    content.clipShape(Circle()).overlay(Circle().strokeBorder(.white.opacity(0.1), lineWidth: 1))
  }

  /// Nothing to show yet: a record's grooves round the label, in the mix's colour.
  private func record(_ hue: Double) -> some View {
    ZStack {
      Circle().fill(tone(0.17, 0.04, hue))
      ForEach(1..<8) { i in
        Circle().strokeBorder(tone(0.22, 0.05, hue), lineWidth: 1).padding(width * groove(i))
      }
      Circle().fill(tone(0.72, 0.14, hue)).padding(width * MixOrbit.hero * 0.33)
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
