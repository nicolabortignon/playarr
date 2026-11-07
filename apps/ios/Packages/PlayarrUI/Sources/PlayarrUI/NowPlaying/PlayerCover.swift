import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// The player's cover, the mini player's and the iPad bar's (apps/web/src/components/PlayerCover.tsx). During a DJ blend
/// it shows both songs' covers overlapping (plan 7 §2; docs/design.md, Moments): the one being left behind at the top
/// left, the one coming in in front at the bottom right, each at 78 % and as present as its song is in the mix, so the
/// second fades in as its song comes in and the first fades out as its song goes; the second grows back to the whole
/// cover once the first has gone. Paused, they stay where the mix is. Under Reduce Motion the two just sit together for
/// as long as the blend lasts. Its frames are made outside the main actor, as SwiftUI may draw them off the main thread.
struct PlayerCover: View {
  let player: Player
  let track: Track
  let points: CGFloat
  var circle = false
  var corner: CGFloat = Radius.cover
  @Environment(\.reducesMotion) private var reducesMotion

  /// Each cover's size during a blend, of the whole.
  static let blendScale: CGFloat = 0.78

  var body: some View {
    let blend = player.blend
    // The first place keeps the song playing until a blend starts, then the song being left (the same cover, which
    // shrinks into its corner); the second has the song coming in.
    let first = blend?.from ?? track
    TimelineView(
      .animation(minimumInterval: 1.0 / 30, paused: blend == nil || reducesMotion || !player.queue.playing),
      content: Self.mixing(leaving(first, blending: blend != nil), coming: blend.map { coming($0.to) }, blend: blend, pulse: player.pulse, still: reducesMotion)
    )
    .frame(width: points, height: points)
    .animation(.easeOut(duration: 0.25), value: blend != nil)
  }

  private func cover(_ track: Track) -> Cover {
    Cover(path: track.coverUrl, points: points, label: track.albumTitle, color: track.coverColor, circle: circle, corner: corner)
  }

  /// The song playing, or the one a blend leaves: shrunk into the top left while the blend lasts. After a blend the
  /// song that came in takes this place, growing from where it was to the whole cover.
  private func leaving(_ track: Track, blending: Bool) -> some View {
    cover(track)
      .scaleEffect(blending ? Self.blendScale : 1, anchor: .topLeading)
      .id(track.fileId)
      .transition(.asymmetric(insertion: .scale(scale: Self.blendScale, anchor: .bottomTrailing), removal: .identity))
  }

  /// The song a blend brings in: in front, at the bottom right.
  private func coming(_ track: Track) -> some View {
    cover(track)
      .shadow(color: .black.opacity(0.5), radius: 3, y: 2)
      .scaleEffect(Self.blendScale, anchor: .bottomTrailing)
      .id(track.fileId)
      .transition(.identity)
  }

  /// Both places at the moment of each frame, each as present as its song is in the mix being heard.
  nonisolated static func mixing<First: View, Second: View>(_ first: First, coming second: Second?, blend: Blend?, pulse: Pulse, still: Bool)
    -> (TimelineViewDefaultContext) -> AnyView
  {
    { _ in
      var shares: (from: Double, to: Double) = (1, 1)
      if let blend, !still { shares = Blend.shares(blend.plan, at: pulse.frame().engineTime - blend.start) }
      return AnyView(
        ZStack {
          first.opacity(shares.from)
          second.opacity(shares.to)
        })
    }
  }
}
