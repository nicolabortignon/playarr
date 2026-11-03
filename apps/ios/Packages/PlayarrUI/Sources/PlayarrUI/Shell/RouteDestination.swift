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
    case .favorites: PlaceholderPage(title: "Favorites")  // phase 6
    case .playlists: PlaceholderPage(title: "Playlists")  // phase 6
    // Phase 6: the playlist's "Songs like these" row (PlaylistRecommendations.tsx) puts phase 8's request button in its
    // trailing slot for songs not in the library: `if let album = rec.album, let availability = rec.availability {
    // RequestButton(album: album, availability: availability, small: true) }`, and links its artist and album with
    // `DiscoverDestination.artist(id:mbid:name:).route` and `.album(id:artistMbid:artistName:title:).route`.
    case .playlist: PlaceholderPage(title: "Playlist")  // phase 6
    case .mixes: PlaceholderPage(title: "Made for you")  // phase 6
    case .mix: PlaceholderPage(title: "Mix")  // phase 6
    case .listening: PlaceholderPage(title: "Your listening")  // phase 6
    case .discoverArtist(let mbid, let album): DiscoverArtistPage(mbid: mbid, album: album)
    case .findArtist(let name, let album): FindArtistPage(name: name, album: album)
    case .requests: RequestsPage()
    }
  }
}

extension View {
  /// Every page a tab's stack can show.
  func routeDestinations(_ session: AccountSession) -> some View {
    navigationDestination(for: Route.self) { RouteDestination(route: $0, session: session) }
  }
}
