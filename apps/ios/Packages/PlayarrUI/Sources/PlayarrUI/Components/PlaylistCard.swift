import PlayarrAPI
import SwiftUI

/// A playlist: its generated cover (drawn by the server; no title on it below 120 points), name and songs. A long press
/// opens the playlist's menu, Play and Shuffle first (`PlayableMenu.playlist`).
struct PlaylistCard: View {
  let playlist: PlaylistSummary
  var width: CGFloat = ShelfCard.width

  @Environment(AccountSession.self) private var session

  var body: some View {
    NavigationLink(value: Route.playlist(playlist.id)) {
      VStack(alignment: .leading, spacing: 6) {
        PlaylistCover(cover: playlist.cover, points: width, name: playlist.name)
        Text(playlist.name).typeRole(.body).essentialLineLimit()
        Text(subtitle).typeRole(.meta).foregroundStyle(.muted).essentialLineLimit()
      }
      .frame(width: width)
    }
    .buttonStyle(.plain)
    .pointerHover()
    .accessibilityLabel("\(playlist.name), \(subtitle)")
    .accessibilityAddTraits(.isButton)
    .contextMenu {
      if playlist.trackCount > 0 { MenuButtons(groups: PlayableMenu.playlist(playlist.id, card: true, session: session)) }
    }
  }

  /// "12 songs", and whose it is when it isn't yours: "12 songs · Sam".
  var subtitle: String { Format.plural(playlist.trackCount, "song") + (playlist.mine ? "" : " · \(playlist.owner)") }
}

/// The playlist's artwork (apps/web/src/components/PlaylistCover.tsx), drawn by the server with the playlist's name on
/// it, as on a card. Small, or on the playlist's own page (which sets the name beside it), without.
struct PlaylistCover: View {
  /// Below this the title on the cover would be unreadable, and lists show the name beside it anyway.
  static let titleMinPoints: CGFloat = 120

  let cover: PlaylistCoverInfo
  let points: CGFloat
  let name: String
  /// With its name drawn on it; the playlist's own page shows the name beside it instead.
  var titled = true

  var body: some View {
    Cover(path: Self.path(cover.url, points: points, titled: titled), points: points, label: name)
  }

  /// The server path of the cover: with `title=0` where the name stays off it.
  static func path(_ url: String, points: CGFloat, titled: Bool) -> String {
    guard !titled || points < titleMinPoints else { return url }
    return url + (url.contains("?") ? "&" : "?") + "title=0"
  }
}
