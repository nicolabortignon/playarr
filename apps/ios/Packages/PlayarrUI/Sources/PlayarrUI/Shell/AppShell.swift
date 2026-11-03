import PlayarrAPI
import SwiftUI

/// The signed-in app on a phone: Home, Search, Library and Queue tabs (apps/web/src/components/Nav.tsx), the mini
/// player above them, Now Playing over everything, and toasts.
struct AppShell: View {
  let model: AppModel
  let session: AccountSession
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

  var body: some View {
    @Bindable var router = session.router
    TabView(selection: Binding(get: { router.tab }, set: { router.select($0) })) {
      ForEach(AppTab.allCases, id: \.self) { tab in
        Tab(tab.title, systemImage: tab.systemImage, value: tab, role: tab == .search ? .search : nil) {
          NavigationStack(path: Binding(get: { router.paths[tab] ?? [] }, set: { router.paths[tab] = $0 })) {
            root(tab).routeDestinations(session)
          }
        }
      }
    }
    .minimizingTabBar()
    .miniPlayer(isShown: session.player.queue.currentTrack != nil) { MiniPlayer(session: session) }
    .nowPlayingCover(isPresented: $router.nowPlaying) {
      NowPlayingView(session: session).environment(session).environment(model.theme).environment(model.appearance)
        .overlay(alignment: .top) { ToastsView().environment(model.toasts).environment(model.theme) }
    }
    .overlay(alignment: .top) { ToastsView() }
    .sheet(isPresented: Binding(get: { model.showingAccounts }, set: { model.showingAccounts = $0 })) { AccountSwitcherView(model: model) }
    // Settings → Appearance → Motion: Reduced keeps animations to a minimum, whatever the device says.
    .transaction { if model.appearance.reduceMotion(system: systemReduceMotion) { $0.animation = nil } }
    .tint(model.theme.accent.color)
    .preferredColorScheme(.dark)
    .environment(session)
    .environment(model)
    .environment(model.theme)
    .environment(model.appearance)
    .environment(model.toasts)
    .task(id: session.player.queue.currentTrack?.coverUrl) {
      await model.theme.follow(cover: session.player.queue.currentTrack?.coverUrl, images: session.images)
    }
    .onChange(of: session.player.notice) { _, notice in
      if let notice { model.toasts.push(notice.text, tone: notice.isError ? .error : .info) }
    }
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
