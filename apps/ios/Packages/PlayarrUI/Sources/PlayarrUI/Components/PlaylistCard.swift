import PlayarrAPI
import SwiftUI

/// A playlist: its generated cover (drawn by the server; no title on it below 120 points), name and songs.
struct PlaylistCard: View {
  let playlist: PlaylistSummary
  var width: CGFloat = ShelfCard.width

  var body: some View {
    NavigationLink(value: Route.playlist(playlist.id)) {
      VStack(alignment: .leading, spacing: 6) {
        PlaylistCover(cover: playlist.cover, points: width, name: playlist.name)
        Text(playlist.name).font(.sans(.subheadline)).lineLimit(1)
        Text(subtitle).font(.mono(.caption)).foregroundStyle(.secondary).lineLimit(1)
      }
      .frame(width: width)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(playlist.name), \(subtitle)")
    .accessibilityAddTraits(.isButton)
  }

  /// "12 songs", and whose it is when it isn't yours: "12 songs · Sam".
  var subtitle: String { Format.plural(playlist.trackCount, "song") + (playlist.mine ? "" : " · \(playlist.owner)") }
}

/// The playlist's artwork (apps/web/src/components/PlaylistCover.tsx).
struct PlaylistCover: View {
  /// Below this the title on the cover would be unreadable, and lists show the name beside it anyway.
  static let titleMinPoints: CGFloat = 120

  let cover: PlaylistCoverInfo
  let points: CGFloat
  let name: String

  var body: some View {
    let separator = cover.url.contains("?") ? "&" : "?"
    let path = points < Self.titleMinPoints ? cover.url + separator + "title=0" : cover.url
    Cover(path: path, points: points, label: name)
  }
}
