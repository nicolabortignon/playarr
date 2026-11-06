import SwiftUI

/// A stand-in while something loads (docs/design.md, "Empty, loading and error"; apps/web/src/components/States.tsx
/// `Skeleton`): a faint block that breathes, never a spinner on its own for a page. The shapes below put it in the form
/// of what it stands for, so nothing jumps when the page arrives.
struct Skeleton: View {
  var aspectRatio: CGFloat? = 1
  var height: CGFloat?
  var corner: CGFloat = Radius.cover
  var circle = false

  var body: some View {
    Group {
      if circle {
        Circle().fill(Self.fill)
      } else {
        RoundedRectangle(cornerRadius: corner).fill(Self.fill)
      }
    }
    .aspectRatio(aspectRatio, contentMode: .fit)
    .frame(height: height)
    .modifier(Breathing())
    .accessibilityHidden(true)
  }

  static let fill = Color.paper.opacity(0.08)
}

/// Skeletons fade gently in and out (together, as they appear together); still with Reduce Motion.
private struct Breathing: ViewModifier {
  @Environment(\.reducesMotion) private var reducesMotion
  @State private var dim = false

  func body(content: Content) -> some View {
    content
      .opacity(dim ? 0.5 : 1)
      .onAppear {
        guard !reducesMotion else { return }
        withAnimation(.easeInOut(duration: 1).repeatForever(autoreverses: true)) { dim = true }
      }
  }
}

/// A bar as tall as a line of text in its type role, so a skeleton is as tall as the words it stands for.
struct TextBar: View {
  var role: TypeRole = .body
  /// How much of the line it fills.
  var fraction: CGFloat = 0.6
  @ScaledMetric(relativeTo: .subheadline) private var body15: CGFloat = 12
  @ScaledMetric(relativeTo: .footnote) private var small13: CGFloat = 10
  @ScaledMetric(relativeTo: .caption) private var meta12: CGFloat = 9
  @ScaledMetric(relativeTo: .largeTitle) private var title34: CGFloat = 28

  var body: some View {
    GeometryReader { box in
      Skeleton(aspectRatio: nil, height: barHeight, corner: 3).frame(width: box.size.width * fraction)
    }
    .frame(height: lineHeight)
  }

  /// About 0.8 of the type's size, as the web's `h-[0.8em]`.
  private var barHeight: CGFloat {
    switch role {
    case .pageTitle: title34
    case .sectionTitle: title34 * 0.7
    case .small: small13
    case .meta, .kicker, .badge: meta12
    case .body: body15
    }
  }

  /// The line it sits on: a little taller than the bar, as the text's own line is.
  private var lineHeight: CGFloat { barHeight * 1.5 }
}

/// A card while it loads (an album, an artist, a playlist, a mix), the size of the real one: the cover (a circle for
/// an artist), then its two lines of text.
struct CardSkeleton: View {
  var round = false
  var width: CGFloat?

  var body: some View {
    VStack(alignment: round ? .center : .leading, spacing: 6) {
      Skeleton(circle: round)
      TextBar(role: .body, fraction: round ? 0.6 : 0.75)
      if !round { TextBar(role: .small, fraction: 0.5) }
    }
    .frame(width: width)
    .accessibilityHidden(true)
  }
}

/// A grid's or a shelf's first screen of cards while they load.
struct CardSkeletons: View {
  /// As many as fill the first screen of the widest grid.
  var count = 12
  var round = false
  var width: CGFloat?

  var body: some View {
    ForEach(0..<count, id: \.self) { _ in CardSkeleton(round: round, width: width) }
  }
}

/// Song rows while they load, each the height of the real row (`SongRow`): the cover or the number, the title over
/// the subtitle, the length, and the room ♥ and ⋯ take.
struct SongRowsSkeleton: View {
  var count = 8
  var lead = SongRow.Lead.cover

  var body: some View {
    VStack(spacing: 0) {
      ForEach(0..<count, id: \.self) { index in
        HStack(spacing: 12) {
          switch lead {
          case .cover: Skeleton().frame(width: 44, height: 44)
          case .number: Skeleton(aspectRatio: nil, height: 10).frame(width: 14).frame(width: 32)
          }
          VStack(alignment: .leading, spacing: 2) {
            TextBar(role: .body, fraction: [0.55, 0.7, 0.45][index % 3])
            if lead == .cover { TextBar(role: .small, fraction: 0.35) }
          }
          Skeleton(aspectRatio: nil, height: 9, corner: 3).frame(width: 32)
          Color.clear.frame(width: 88, height: 44)
        }
        .frame(minHeight: SongRow.height)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Loading songs")
  }
}

/// Rows of a list while they load (Library's playlists, Requests): a cover and two lines.
struct ListRowsSkeleton: View {
  var count = 4
  var cover: CGFloat = 56

  var body: some View {
    ForEach(0..<count, id: \.self) { index in
      HStack(spacing: 14) {
        Skeleton().frame(width: cover, height: cover)
        VStack(alignment: .leading, spacing: 4) {
          TextBar(role: .body, fraction: [0.5, 0.65, 0.4][index % 3])
          TextBar(role: .meta, fraction: 0.25)
        }
      }
      .accessibilityHidden(true)
    }
  }
}

/// A page you can play while it loads (an album, a playlist, a mix), laid out as `DetailHeader` lays it out: the cover
/// (above the words on a phone, beside them at regular width), the kicker, the title, the meta line and the action row,
/// then its first songs.
struct DetailSkeleton: View {
  var songs = 8
  @Environment(\.horizontalSizeClass) private var sizeClass

  var body: some View {
    VStack(alignment: .leading, spacing: 24) {
      if sizeClass == .regular {
        VStack(alignment: .leading, spacing: 32) {
          HStack(alignment: .bottom, spacing: 32) {
            Skeleton().frame(width: 240)
            words
          }
          actions
        }
      } else {
        VStack(alignment: .leading, spacing: 0) {
          Skeleton()
            .containerRelativeFrame(.horizontal) { width, _ in DetailCover.side(width: width, round: false) }
            .frame(maxWidth: .infinity)
            .padding(.bottom, 20)
          words
          actions.padding(.top, 24)
        }
      }
      SongRowsSkeleton(count: songs)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Loading")
  }

  private var words: some View {
    VStack(alignment: .leading, spacing: 0) {
      TextBar(role: .kicker, fraction: 0.2)
      TextBar(role: .pageTitle, fraction: 0.7).padding(.top, 6)
      TextBar(role: .meta, fraction: 0.45).padding(.top, 12)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// Play, Shuffle, Download and ⋯, at their sizes.
  private var actions: some View {
    HStack(spacing: 10) {
      Capsule().fill(Skeleton.fill).frame(width: 112, height: PillSize.large.height)
      Capsule().fill(Skeleton.fill).frame(width: 120, height: PillSize.large.height)
      Circle().fill(Skeleton.fill).frame(width: 48, height: 48)
      Circle().fill(Skeleton.fill).frame(width: 48, height: 48)
    }
  }
}
