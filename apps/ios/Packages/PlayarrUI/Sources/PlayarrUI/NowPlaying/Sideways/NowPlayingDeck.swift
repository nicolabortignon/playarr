import PlayarrPlayer
import SwiftUI

/// The deck at the foot of the sideways tracklist: the seek bar with both times, then shuffle, previous, play or
/// pause, next and repeat, on a glass panel the tracklist scrolls under.
struct NowPlayingDeck: View {
  let player: Player

  var body: some View {
    VStack(spacing: 2) {
      SeekBar(player: player)
      PlayerBarTransport(player: player, playSize: 56, spacing: 20)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
    .glassEffect(in: RoundedRectangle(cornerRadius: 24))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("nowPlaying.deck")
  }
}
