import SwiftUI

/// The phone layout (phase 4's tabs, moved here from AppShell): Home, Search, Library and Queue, each a stack of
/// pages, with the mini player above the tab bar. iPad windows narrower than the web's desktop width get it too.
struct TabShell: View {
  let session: AccountSession

  var body: some View {
    let router = session.router
    TabView(selection: Binding(get: { router.tab }, set: { router.select($0) })) {
      ForEach(AppTab.allCases, id: \.self) { tab in
        Tab(tab.title, systemImage: tab.systemImage, value: tab, role: tab == .search ? .search : nil) {
          NavigationStack(path: Binding(get: { router.paths[tab] ?? [] }, set: { router.paths[tab] = $0 })) {
            root(tab).underTheRail().accountMenu().shellDestinations(session)
          }
        }
      }
    }
    .minimizingTabBar()
    .miniPlayer(isShown: session.player.queue.currentTrack != nil) { MiniPlayer(session: session) }
  }

  @ViewBuilder private func root(_ tab: AppTab) -> some View {
    switch tab {
    case .home: HomeView(session: session)
    case .search: SearchView(session: session)
    case .library: LibraryView(session: session)
    case .queue: QueueView(session: session)
    }
  }
}

extension View {
  /// Every page a stack can show, in the tabs and in the iPad's detail column alike.
  func shellDestinations(_ session: AccountSession) -> some View {
    routeDestinations(session)
  }
}
