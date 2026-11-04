import PlayarrAPI

/// A place in the iPad sidebar (apps/web/src/components/Nav.tsx `Sidebar`): the desktop links, Requests while
/// there are some, the playlists and Settings.
public enum SidebarItem: Hashable, Sendable, Codable {
  case home, search, mixes, artists, albums, favorites, downloads, queue, requests, playlists
  case playlist(Int)
  case settings

  /// The desktop links, in the web's order (`LINKS`).
  public static let links: [SidebarItem] = [.home, .search, .mixes, .artists, .albums, .favorites, .downloads, .queue]

  public var title: String {
    switch self {
    case .home: "Home"
    case .search: "Search"
    case .mixes: "Made for you"
    case .artists: "Artists"
    case .albums: "Albums"
    case .favorites: "Favorites"
    case .downloads: "Downloads"
    case .queue: "Queue"
    case .requests: "Requests"
    case .playlists: "Playlists"
    case .playlist: "Playlist"
    case .settings: "Settings"
    }
  }

  public var systemImage: String {
    switch self {
    case .home: "house"
    case .search: "magnifyingglass"
    case .mixes: "sparkles"
    case .artists: "music.mic"
    case .albums: "square.stack"
    case .favorites: "heart"
    case .downloads: "arrow.down.circle"
    case .queue: "list.bullet"
    case .requests: "arrow.down.to.line"
    case .playlists, .playlist: "music.note.list"
    case .settings: "gearshape"
    }
  }

  /// What UI tests find it by: "sidebar.home", "sidebar.playlist.3".
  public var identifier: String {
    switch self {
    case .playlist(let id): "sidebar.playlist.\(id)"
    default: "sidebar.\(String(describing: self))"
    }
  }

  /// The page it opens; nil for Home, Search and Queue, which are the tabs' own first pages.
  public var route: Route? {
    switch self {
    case .home, .search, .queue: nil
    case .mixes: .mixes
    case .artists: .artists
    case .albums: .albums(.artist)
    case .favorites: .favorites
    case .downloads: .downloads
    case .requests: .requests
    case .playlists: .playlists
    case .playlist(let id): .playlist(id)
    case .settings: .settings
    }
  }

  /// The item whose first page is `route`, if any.
  public init?(route: Route) {
    guard let item = Self.withPages.first(where: { $0.route == route }) else {
      if case .playlist(let id) = route { self = .playlist(id); return }
      return nil
    }
    self = item
  }

  private static let withPages: [SidebarItem] = [.mixes, .artists, .albums, .favorites, .downloads, .requests, .playlists, .settings]

  /// Where a phone's place lands in the sidebar when the window widens: Home, Search and Queue are items; a page
  /// opened from Library that has an item (Artists, a playlist…) becomes that item, the rest of the stack on top.
  public static func place(tab: AppTab, path: [Route]) -> (item: SidebarItem, detail: [Route]) {
    switch tab {
    case .home: (.home, path)
    case .search: (.search, path)
    case .queue: (.queue, path)
    case .library:
      if let first = path.first, let item = SidebarItem(route: first) {
        (item, Array(path.dropFirst()))
      } else {
        // Library's own list is the sidebar itself.
        (.home, path)
      }
    }
  }

  /// Where this item's place lands on a phone when the window narrows: its tab, or Library with its page first.
  public func place(detail: [Route]) -> (tab: AppTab, path: [Route]) {
    switch self {
    case .home: (.home, detail)
    case .search: (.search, detail)
    case .queue: (.queue, detail)
    default: (.library, (route.map { [$0] } ?? []) + detail)
    }
  }
}
