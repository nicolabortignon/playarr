import SwiftUI

/// The iPad layout (apps/web/src/components/AppShell.tsx on a desktop): the sidebar, the page with its stack, the
/// queue or lyrics in a column on the right when asked for, and the player bar along the bottom.
struct SplitShell: View {
  let session: AccountSession
  @State private var columns = NavigationSplitViewVisibility.all
  /// Where the player bar is, in the window: the sidebar runs the full height of the window, under the bar, so it
  /// keeps Settings clear of it.
  @State private var bar = CGRect.zero

  var body: some View {
    let router = session.router
    NavigationSplitView(columnVisibility: $columns) {
      Sidebar(session: session, bar: bar)
        .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
    } detail: {
      NavigationStack(path: Binding(get: { router.detail }, set: { router.detail = $0 })) {
        root(router.sidebar)
          .accountMenu()
          .shellDestinations(session)
      }
      .id(router.sidebar)
    }
    .inspector(isPresented: Binding(get: { router.column != nil }, set: { if !$0 { router.column = nil } })) {
      SideColumnView(session: session)
        .inspectorColumnWidth(min: 300, ideal: 340, max: 440)
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      PlayerBar(session: session)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { bar = $0 }
    }
  }

  @ViewBuilder private func root(_ item: SidebarItem) -> some View {
    switch item {
    case .home: HomeView(session: session)
    case .search: SearchView(session: session)
    case .queue: QueueView(session: session)
    default:
      if let route = item.route { RouteDestination(route: route, session: session) }
    }
  }
}
