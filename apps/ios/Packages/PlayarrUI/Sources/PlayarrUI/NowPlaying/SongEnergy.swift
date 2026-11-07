import SwiftUI

/// A song's energy under Now Playing's seek bar (plan 7 §6; docs/design.md, Moments; apps/web/src/components/
/// EnergyStrip.tsx `SongEnergy`): its phrases as columns across the whole song, as tall as each sounds, so the drop and
/// the quiet bridge show before you jump there. What's played, or where a drag would land, is in the accent; what's
/// ahead, fainter. Without a picture (a song not analyzed, or its map on its way) its 20 points stay, so nothing under
/// it moves from one song to the next. Drawn as shapes: nothing made on the main actor for SwiftUI to call off it.
struct SongEnergy: View {
  let phrases: [EnergyPicture.Phrase]
  /// Lit up to here, 0–1 of the way.
  let lit: Double

  static let height: CGFloat = 20

  var body: some View {
    ZStack {
      if !phrases.isEmpty {
        EnergyColumns(phrases: phrases).fill(.tint.opacity(0.25))
        EnergyColumns(phrases: phrases).fill(.tint).clipShape(LitPart(fraction: lit))
      }
    }
    .frame(maxWidth: .infinity)
    .frame(height: Self.height)
    .accessibilityHidden(true)
  }
}

/// The phrases as columns along the bottom of their box: as tall as each sounds (`EnergyPicture.heardHeight`, two points
/// at least), a point apart, their tops rounded as the web's `rounded-t-xs`.
struct EnergyColumns: Shape {
  let phrases: [EnergyPicture.Phrase]

  /// The columns' top corners: a mark of the data, not a surface (the web's 2 px).
  nonisolated static let round: CGFloat = 2

  nonisolated func path(in rect: CGRect) -> Path {
    var path = Path()
    for phrase in phrases {
      let height = max(2, CGFloat(EnergyPicture.heardHeight(phrase.energy)) * rect.height)
      let column = CGRect(
        x: rect.minX + phrase.left * rect.width, y: rect.maxY - height, width: max(1, phrase.width * rect.width - 1), height: height)
      path.addRoundedRect(in: column, cornerRadii: RectangleCornerRadii(topLeading: Self.round, topTrailing: Self.round))
    }
    return path
  }
}

/// A box's part from its leading edge to `fraction` of its width.
struct LitPart: Shape {
  var fraction: Double

  nonisolated func path(in rect: CGRect) -> Path {
    Path(CGRect(x: rect.minX, y: rect.minY, width: rect.width * min(1, max(0, fraction)), height: rect.height))
  }
}
