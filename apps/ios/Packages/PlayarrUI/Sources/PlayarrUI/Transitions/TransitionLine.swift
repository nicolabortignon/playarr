import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// "Next: 32-beat blend · 124 → 126 BPM · 8A → 9A" under Now Playing's transport and the queue's current song,
/// opening the transition sheet. Only with DJ mix, and only when the next song is wanted mixed (not when the sleep
/// timer stops after this one). As `TransitionView` in apps/web/src/components/TransitionView.tsx.
public struct TransitionLine: View {
  let player: Player
  @State private var open = false

  public init(player: Player) { self.player = player }

  /// The two songs, when the line shows at all.
  private var pair: (from: Track, to: Track)? {
    guard player.settings.transitions == .dj, !player.sleep.endOfSong, let from = player.queue.currentTrack,
      let to = player.queue.upNext, from.fileId != to.fileId
    else { return nil }
    let upcoming = player.transitions.planner.upcoming
    // With mixing on, the planner names the pair it's working on; any other pair isn't mixed.
    let wanted = player.queue.mixMode == .off || (upcoming.fromFileId == from.fileId && upcoming.toFileId == to.fileId)
    return wanted ? (from, to) : nil
  }

  public var body: some View {
    if let pair {
      let maps = player.transitions.mixMaps
      let words = TransitionWords.describe(player.transitions.result(from: pair.from, to: pair.to), mixMode: player.queue.mixMode)
      let text = TransitionWords.line(words, maps.map(pair.from.recordingId), maps.map(pair.to.recordingId))
      Button {
        open = true
      } label: {
        Label(text, systemImage: "arrow.triangle.merge")
          .font(.sans(.footnote).monospacedDigit())
          .lineLimit(1)
          .foregroundStyle(.secondary)
          .frame(minHeight: 44)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(TransitionWords.spoken(text))
      .accessibilityHint("Shows how the next song comes in")
      .task(id: [pair.from.recordingId, pair.to.recordingId]) { maps.watch([pair.from.recordingId, pair.to.recordingId]) }
      .sheet(isPresented: $open) {
        TransitionSheet(player: player, from: pair.from, to: pair.to)
          .presentationDetents([.medium, .large])
      }
    }
  }
}
