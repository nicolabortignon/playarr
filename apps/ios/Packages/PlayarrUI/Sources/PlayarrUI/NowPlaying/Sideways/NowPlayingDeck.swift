import PlayarrPlayer
import SwiftUI

/// The deck under the sleeve's cover, for the left thumb: the seek bar with both times, then shuffle, previous, play or
/// pause, next and repeat, as wide as the cover (`NowPlayingLayout.deckWidth` at least).
struct NowPlayingDeck: View {
  let player: Player

  var body: some View {
    VStack(spacing: 4) {
      SeekBar(player: player)
      PlayerBarTransport(player: player, playSize: 52, spacing: 6)
    }
    .frame(minWidth: NowPlayingLayout.deckWidth, maxWidth: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("nowPlaying.deck")
  }
}
