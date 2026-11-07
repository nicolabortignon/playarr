import SwiftUI

/// The phone layout (phase 4's tabs, moved here from AppShell): Home, Search, Library and Queue, each a stack of
/// pages, with the mini player above the tab bar. iPad windows narrower than the web's desktop width get it too.
struct TabShell: View {
  let session: AccountSession
  /// Album pages grow from the cards pressed to open them (`CoverZoom`): every card is its own source, so the tabs'
  /// stacks share one namespace, set on the tabs as a whole (pages pushed take their surroundings from there, as in the
  /// iPad's split view).
  @Namespace private var covers

  var body: some View {
    let router = session.router
    TabView(selection: Binding(get: { router.tab }, set: { router.select($0) })) {
      ForEach(AppTab.allCases, id: \.self) { tab in
        Tab(tab.title, systemImage: tab.systemImage, value: tab, role: tab == .search ? .search : nil) {
          NavigationStack(path: Binding(get: { router.paths[tab] ?? [] }, set: { router.paths[tab] = $0 })) {
            root(tab).underTheRail().accountMenu().shellDestinations(session)
          }
        }
        // Requests live in Library on a phone: its tab carries their news (the web's bottom bar too).
        .badge(tab == .library ? session.discover.requests.newsCount : 0)
      }
    }
    .environment(\.coverZoom, covers)
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
