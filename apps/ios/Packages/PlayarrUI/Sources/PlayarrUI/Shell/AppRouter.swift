import Foundation
import Observation

/// Where the app is: the tab, each tab's stack of pages, and whether Now Playing (and its lyrics) is open.
@MainActor @Observable
public final class AppRouter {
  public var tab: AppTab = .home
  public var paths: [AppTab: [Route]] = [:]
  public var nowPlaying = false
  public var lyrics = false

  public init() {}

  /// Picks a tab; picking the one shown goes back to its first page, as iOS tab bars do.
  public func select(_ tab: AppTab) {
    if tab == self.tab {
      paths[tab] = []
    } else {
      self.tab = tab
    }
  }

  /// Opens a page on top of the current tab.
  public func open(_ route: Route) {
    paths[tab, default: []].append(route)
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

  /// Now Playing → Open queue.
  public func showQueue() {
    nowPlaying = false
    tab = .queue
    paths[.queue] = []
  }
}
