import Foundation

/// Where the app was, kept in the scene's storage so iOS can bring the window back as it was after it closed the
/// app in the background: the tab or sidebar item, their pages, Now Playing and the side column. Only for the
/// account that was signed in.
public struct RouterSnapshot: Codable, Equatable, Sendable {
  public var account: String
  public var layout: ShellLayout
  public var tab: AppTab
  public var paths: [AppTab: [Route]]
  public var sidebar: SidebarItem
  public var detail: [Route]
  public var nowPlaying: Bool
  public var lyrics: Bool
  public var column: SideColumn?

  public var data: Data? { try? JSONEncoder().encode(self) }

  public init?(data: Data?) {
    guard let data, let snapshot = try? JSONDecoder().decode(RouterSnapshot.self, from: data) else { return nil }
    self = snapshot
  }

  @MainActor init(account: String, router: AppRouter) {
    self.account = account
    layout = router.layout
    tab = router.tab
    paths = router.paths
    sidebar = router.sidebar
    detail = router.detail
    nowPlaying = router.nowPlaying
    lyrics = router.lyrics
    column = router.column
  }
}

extension AppRouter {
  public func snapshot(account: String) -> RouterSnapshot {
    RouterSnapshot(account: account, router: self)
  }

  /// Puts the app back where `snapshot` was, if it was this account's. Now Playing opens again only with a song.
  public func restore(_ snapshot: RouterSnapshot, account: String, hasSong: Bool) {
    guard snapshot.account == account else { return }
    layout = snapshot.layout
    tab = snapshot.tab
    paths = snapshot.paths
    sidebar = snapshot.sidebar
    detail = snapshot.detail
    nowPlaying = snapshot.nowPlaying && hasSong
    lyrics = snapshot.lyrics
    column = snapshot.column
  }
}

extension AppTab: Codable {}
