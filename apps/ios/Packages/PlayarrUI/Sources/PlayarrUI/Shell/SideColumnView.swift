import SwiftUI

/// The column on the right of the iPad layout: the queue (songs can be dropped on it) or the lyrics of the song
/// playing, switched at its top.
struct SideColumnView: View {
  let session: AccountSession
  @State private var dropped = 0

  var body: some View {
    let router = session.router
    VStack(spacing: 0) {
      Picker("Show", selection: Binding(get: { router.column ?? .queue }, set: { router.column = $0 })) {
        ForEach(SideColumn.allCases, id: \.self) { Text($0.title).tag($0) }
      }
      .pickerStyle(.segmented)
      .padding(12)
      switch router.column ?? .queue {
      case .queue:
        NavigationStack { QueueView(session: session, narrow: true) }
          .dropDestination(for: TrackDrag.self) { drops, _ in
            session.actions.addToQueue(TrackDrag.tracks(drops))
            dropped += 1
            return true
          }
      case .lyrics:
        if let track = session.player.queue.currentTrack {
          LyricsView(trackId: track.id, session: session).id(track.id)
        } else {
          ContentUnavailableView("Nothing playing", systemImage: "quote.bubble")
        }
      }
    }
    // Playarr's own dark behind the queue and lyrics, rather than the inspector's glass over the page.
    .background(Color(red: 0x0F / 255, green: 0x0E / 255, blue: 0x0C / 255))
    .sensoryFeedback(Haptic.dropped, trigger: dropped)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("sideColumn")
  }
}
