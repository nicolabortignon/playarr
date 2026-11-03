import PlayarrPlayer
import SwiftUI

/// The page for a route: the same in every tab's stack (and, later, in an iPad split view).
struct RouteDestination: View {
  let route: Route
  let session: AccountSession
  @Environment(Theme.self) private var theme

  var body: some View {
    switch route {
    case .album(let id): AlbumView(id: id, session: session, theme: theme)
    case .artist(let id): ArtistView(id: id, session: session)
    case .albums(let sort): AlbumsView(session: session, sort: sort)
    case .artists: ArtistsView(session: session)
    case .settings: SettingsView(session: session)
    case .settingsPanel(let panel): SettingsPanelView(panel: panel, session: session)
    case .favorites: FavoritesView(session: session)
    case .playlists: PlaylistsView(session: session)
    case .playlist(let id): PlaylistView(id: id, session: session)
    case .mixes: MixesView(session: session)
    case .mix(let key): MixView(key: key, session: session)
    case .listening: StatsView(range: nil, session: session)
    case .listeningRange(let range): StatsView(range: range, session: session)
    case .discoverArtist(let mbid, let album): DiscoverArtistPage(mbid: mbid, album: album)
    case .findArtist(let name, let album): FindArtistPage(name: name, album: album)
    case .requests: RequestsPage()
    case .downloads:
      DownloadsView(
        store: session.player.downloads,
        play: { d in session.player.play(d.tracks, source: PlaySource(label: d.title, href: d.href)) },
        open: { session.router.open(href: $0) }
      ) { path in
        Cover(path: path, points: 56)
      }
    }
  }
}

extension View {
  /// Every page a tab's stack can show.
  func routeDestinations(_ session: AccountSession) -> some View {
    navigationDestination(for: Route.self) { RouteDestination(route: $0, session: session) }
  }
}
