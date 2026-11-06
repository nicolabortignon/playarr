import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Now Playing's "Up next" on an iPad (apps/web/src/components/NowPlaying.tsx `UpNext`, desktop only): the next four
/// songs as song rows (tap one to play from it, ⋯ for its menu), and Queue to see the rest.
struct UpNextPreview: View {
  static let count = 4

  let session: AccountSession

  /// The next songs in play order, with their place in it (what `jump(to:)` takes).
  static func entries(_ queue: QueueState) -> [(orderPos: Int, track: Track)] {
    guard queue.pos >= 0 else { return [] }
    return queue.order.indices.dropFirst(queue.pos + 1).prefix(count).map { ($0, queue.queue[queue.order[$0]]) }
  }

  var body: some View {
    let entries = Self.entries(session.player.queue)
    if !entries.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Kicker(text: "Up next", overArt: true).accessibilityAddTraits(.isHeader)
          Spacer()
          Button { session.router.showQueue() } label: { Kicker(text: "Queue", overArt: true).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()) }
            .buttonStyle(.plain)
            .accessibilityLabel("Open queue")
        }
        ForEach(entries, id: \.orderPos) { entry in
          row(entry.track, at: entry.orderPos)
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("nowPlaying.upNext")
    }
  }

  /// A song coming up: the one song row, smaller, the artist under the title, with Up next's menu (Play next moves it
  /// up; Move up, Move down and Remove from queue after a line).
  private func row(_ track: Track, at orderPos: Int) -> some View {
    let queue = session.player.queue
    let position = orderPos - queue.pos - 1
    return SongRow(
      track: track, subtitle: [track.artistName], markCurrent: false, compact: true, overArt: true, drags: false,
      place: SongMenu.upNext(position, of: queue.order.count - queue.pos - 1, session: session), hint: "Plays from this song"
    ) {
      session.player.jump(to: orderPos)
    }
  }
}
