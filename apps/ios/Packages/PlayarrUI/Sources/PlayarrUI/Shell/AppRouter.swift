import Foundation
import Observation

/// Where the app is: the tab and each tab's stack of pages (or, on an iPad, the sidebar item, its pages and the side
/// column), and whether Now Playing (and its lyrics) is open.
@MainActor @Observable
public final class AppRouter {
  public var tab: AppTab = .home
  public var paths: [AppTab: [Route]] = [:]
  public var nowPlaying = false
  public var lyrics = false
  /// The window's layout (`AdaptiveShell` keeps it in step); `setLayout(_:)` carries the place across.
  public internal(set) var layout: ShellLayout = .tabs
  /// The iPad layout's sidebar item, and the stack of pages in its detail column.
  public var sidebar: SidebarItem = .home
  public var detail: [Route] = []
  /// The column on the right of the iPad layout; nil while closed.
  public var column: SideColumn?
  /// Search's field should take the cursor when it next shows ("/" on a keyboard); Search sets it back.
  public var focusSearch = false
  /// A query for Search to take (`search(_:)`); Search clears it once it has.
  public var searchQuery: String?

  public init() {}

  /// How many pages are open over Search (its tab's, or on an iPad its detail column's): one more is a result opened
  /// from it, which makes the search a recent one.
  public var searchDepth: Int {
    switch layout {
    case .tabs: paths[.search]?.count ?? 0
    case .split: sidebar == .search ? detail.count : 0
    }
  }

  /// Picks a tab; picking the one shown goes back to its first page, as iOS tab bars do.
  public func select(_ tab: AppTab) {
    if tab == self.tab {
      paths[tab] = []
    } else {
      self.tab = tab
    }
  }

  /// Picks a sidebar item, on its first page (picking the one shown goes back to it too).
  public func select(sidebar item: SidebarItem) {
    sidebar = item
    detail = []
  }

  /// Opens a page on top of the current tab, or of the detail column.
  public func open(_ route: Route) {
    switch layout {
    case .tabs: paths[tab, default: []].append(route)
    case .split: detail.append(route)
    }
  }

  /// Opens a web path ("Playing from" links): a page, or the Queue tab for "/queue".
  public func open(href: String) {
    if href == "/queue" {
      showQueue()
    } else if let route = Route(href: href) {
      go(route)
    }
  }

  /// From Now Playing: close it and open the page.
  public func go(_ route: Route) {
    nowPlaying = false
    open(route)
  }

  /// Search for `query` (Find artist's "Search for … instead", Requests' "Search"): Search, at its first page.
  public func search(_ query: String) {
    nowPlaying = false
    switch layout {
    case .tabs:
      tab = .search
      paths[.search] = []
    case .split:
      select(sidebar: .search)
    }
    searchQuery = query
  }

  /// Back home, from a page that couldn't load: Home at its first page (the page that failed stays where it was, to
  /// try again from later).
  public func goHome() {
    nowPlaying = false
    switch layout {
    case .tabs:
      tab = .home
      paths[.home] = []
    case .split:
      select(sidebar: .home)
    }
  }

  /// Now Playing → Open queue: the Queue tab on a phone, the queue column on an iPad.
  public func showQueue() {
    nowPlaying = false
    switch layout {
    case .tabs:
      tab = .queue
      paths[.queue] = []
    case .split:
      column = .queue
    }
  }

  /// "/" on a keyboard: Search, with the cursor in its field.
  public func openSearch() {
    nowPlaying = false
    switch layout {
    case .tabs:
      tab = .search
      paths[.search] = []
    case .split:
      select(sidebar: .search)
    }
    focusSearch = true
  }

  /// The window became wide enough for the sidebar, or too narrow for it: the same page stays on screen.
  public func setLayout(_ new: ShellLayout) {
    guard new != layout else { return }
    switch new {
    case .split:
      (sidebar, detail) = SidebarItem.place(tab: tab, path: paths[tab] ?? [])
    case .tabs:
      let (tab, path) = sidebar.place(detail: detail)
      self.tab = tab
      paths[tab] = path
      column = nil
    }
    layout = new
  }
}
