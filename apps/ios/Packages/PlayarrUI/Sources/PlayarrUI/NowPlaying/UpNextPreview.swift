import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Now Playing's "Up next" on an iPad (apps/web/src/components/NowPlaying.tsx `UpNext`, desktop only): the next four
/// songs, tap one to play from it, and Queue to see the rest.
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
          Kicker(text: "Up next").accessibilityAddTraits(.isHeader)
          Spacer()
          Button { session.router.showQueue() } label: { Kicker(text: "Queue").frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()) }
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

  private func row(_ track: Track, at orderPos: Int) -> some View {
    Button { session.player.jump(to: orderPos) } label: {
      HStack(spacing: 12) {
        Cover(path: track.coverUrl, points: 36, label: track.albumTitle, corner: 3).frame(width: 36, height: 36)
        VStack(alignment: .leading, spacing: 0) {
          Text(track.title).font(.subheadline).essentialLineLimit()
          Text(track.artistName).font(.caption).foregroundStyle(.muted).essentialLineLimit()
        }
        Spacer(minLength: 8)
        Text(Format.time(track.duration)).font(.caption.monospacedDigit()).foregroundStyle(.muted)
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .pointerHover()
    .accessibilityLabel("\(track.title), \(track.artistName), \(Format.time(track.duration))")
    .accessibilityHint("Plays from this song")
  }
}
