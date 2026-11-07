import PlayarrPlayer
import SwiftUI

/// Under Now Playing's transport (apps/web/src/components/NowPlaying.tsx `MixLine`): during a DJ blend, "Mixing into
/// Teardrop" for the rest of the blend once Teardrop has taken over, until the song being left has faded out of it
/// (plan 7 §2); before the switch the line over the artist says it (`endOfSongLine`), so it's said once at a time and
/// for the whole blend. Otherwise what the next transition will be (`TransitionLine`).
struct MixLine: View {
  let player: Player

  var body: some View {
    if let blend = player.blend, player.queue.currentTrack?.fileId == blend.to.fileId {
      // Two circles overlapping, one fading: the web's Blend, as the transition line's.
      Label("Mixing into \(blend.to.title)", systemImage: "circle.dotted.and.circle")
        .font(.sans(.footnote))
        .lineLimit(1)
        .foregroundStyle(.secondary)
        .frame(minHeight: 44)
    } else {
      TransitionLine(player: player)
    }
  }
}
