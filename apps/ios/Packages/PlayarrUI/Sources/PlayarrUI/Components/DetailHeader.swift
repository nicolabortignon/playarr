import SwiftUI

/// The header of everything you can play (album, playlist, mix, Favorites, artist, an artist's discography), in one
/// order: the cover, a kicker saying what it is, the title, one meta line, then the action row (docs/design.md,
/// "Headers"; apps/web/src/components/DetailHeader.tsx). On a phone the cover sits above the words, 64 % of the width
/// and at most 256 points (an artist's circle 40 % and 160), so Play shows on the first screen; at regular width it
/// sits beside them. The page draws the cover to fill the square it's given. Its page shows the title in the bar once
/// this one has scrolled under it (`titleInBar(_:)`).
struct DetailHeader<Cover: View, Title: View, Meta: View, Actions: View>: View {
  /// What it is: "Album", "Live album", "Playlist", "Made for you", "Artist".
  let kicker: String
  /// An artist's picture: a circle, smaller than a cover.
  var round = false
  /// Drawn over art (a tinted wash, a photo): the kicker and the meta line in `.paperDim` rather than `.muted`.
  var overArt = false
  /// False where the art is drawn elsewhere: beside the page (an iPhone held sideways) or behind it (an artist's photo).
  var showsCover = true
  /// On a phone, the cover at an artist's circle's size: a playlist with nothing in it yet, so the line saying so shows on
  /// the first screen too.
  var smallCover = false
  @ViewBuilder let cover: Cover
  @ViewBuilder let title: Title
  /// The one line under the title (`MetaLine` for words alone), in the meta type role.
  @ViewBuilder let meta: Meta
  /// The action row.
  @ViewBuilder let actions: Actions

  @Environment(\.horizontalSizeClass) private var sizeClass

  init(
    kicker: String, round: Bool = false, overArt: Bool = false, showsCover: Bool = true, smallCover: Bool = false,
    @ViewBuilder cover: () -> Cover, @ViewBuilder title: () -> Title, @ViewBuilder meta: () -> Meta, @ViewBuilder actions: () -> Actions
  ) {
    self.kicker = kicker
    self.round = round
    self.overArt = overArt
    self.showsCover = showsCover
    self.smallCover = smallCover
    self.cover = cover()
    self.title = title()
    self.meta = meta()
    self.actions = actions()
  }

  var body: some View {
    if sizeClass == .regular, showsCover {
      // Beside the words, which line up with its foot (the web's md: layout).
      VStack(alignment: .leading, spacing: 32) {
        HStack(alignment: .bottom, spacing: 32) {
          art.frame(width: round ? 192 : 240)
          words
        }
        actions
      }
    } else {
      VStack(alignment: .leading, spacing: 0) {
        if showsCover {
          art
            .containerRelativeFrame(.horizontal) { width, _ in DetailCover.side(width: width, round: round, small: smallCover) }
            .frame(maxWidth: .infinity)
            .padding(.bottom, 20)
        }
        words
        actions.padding(.top, 24)
      }
    }
  }

  private var art: some View {
    cover
      .aspectRatio(1, contentMode: .fit)
      .coverShadow(.hero)
  }

  private var words: some View {
    VStack(alignment: .leading, spacing: 0) {
      Kicker(text: kicker, overArt: overArt)
      title
        .scrollsUnderBar()
        .padding(.top, 6)
      // Takes no room when there's none (Favorites while it's empty).
      meta
        .typeRole(.meta)
        .foregroundStyle(overArt ? AnyShapeStyle(.paperDim) : AnyShapeStyle(.muted))
        .padding(.top, 12)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// How big a detail header's cover is on a phone.
enum DetailCover {
  /// 64 % of the width, at most 256 points; an artist's circle 40 %, at most 160 (the web's `min(64vw, 256px)` and
  /// `min(40vw, 160px)`). Small enough that Play shows on the first screen; `small` (an empty playlist) as the circle.
  static func side(width: CGFloat, round: Bool, small: Bool = false) -> CGFloat {
    round || small ? min(width * 0.4, 160) : min(width * 0.64, 256)
  }
}

/// A detail page's title: the name in the page-title role, the screen's heading.
struct DetailTitle: View {
  let text: String

  init(_ text: String) { self.text = text }

  var body: some View {
    Text(text)
      .typeRole(.pageTitle)
      .foregroundStyle(.paper)
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityAddTraits(.isHeader)
  }
}

/// A meta line of words alone, its parts joined by dots and the empty ones left out ("3 songs · 17 min · Changes in
/// 9 h"): the web's `joinMeta`.
struct MetaLine: View {
  let parts: [String?]

  init(_ parts: String?...) { self.parts = parts }

  var body: some View {
    // Nothing at all when there's nothing to say: an empty line would still take its height.
    let line = Self.join(parts)
    if !line.isEmpty { Text(line).fixedSize(horizontal: false, vertical: true) }
  }

  static func join(_ parts: [String?]) -> String {
    parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
  }
}
