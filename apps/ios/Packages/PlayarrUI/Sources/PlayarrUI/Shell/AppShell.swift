import PlayarrAPI
import SwiftUI

/// The signed-in app on a phone: Home, Search, Library and Queue tabs (apps/web/src/components/Nav.tsx), the mini
/// player above them, Now Playing over everything, and toasts.
struct AppShell: View {
  let model: AppModel
  let session: AccountSession
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @Environment(\.scenePhase) private var scenePhase

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
      NowPlayingView(session: session)
        // Show metadata and Edit mix points from Now Playing's menu open over it.
        .trackSheets(player: session.player, active: router.nowPlaying)
        .addToPlaylistSheet(session, active: router.nowPlaying)
        .environment(session).environment(session.discover).environment(model.theme).environment(model.appearance)
        .overlay(alignment: .top) { ToastsView().environment(model.toasts).environment(model.theme) }
        .overlay { stats }
    }
    .overlay(alignment: .top) { ToastsView() }
    .overlay { stats }
    .sheet(isPresented: Binding(get: { model.showingAccounts }, set: { model.showingAccounts = $0 })) { AccountSwitcherView(model: model) }
    .addToPlaylistSheet(session, active: !router.nowPlaying)
    .trackSheets(player: session.player, active: !router.nowPlaying)
    // Settings → Appearance → Motion: Reduced keeps animations to a minimum, whatever the device says.
    .transaction { if model.appearance.reduceMotion(system: systemReduceMotion) { $0.animation = nil } }
    .tint(model.theme.accent.color)
    .preferredColorScheme(.dark)
    .environment(session)
    .environment(session.discover)
    .environment(model)
    .environment(model.theme)
    .environment(model.appearance)
    .environment(model.toasts)
    .task(id: session.player.queue.currentTrack?.coverUrl) {
      await model.theme.follow(cover: session.player.queue.currentTrack?.coverUrl, images: session.images)
    }
    // The lock screen's like button shows whether the song playing is a favorite.
    .onChange(of: session.player.queue.currentTrack.map { session.favorites.isFavorite($0.recordingId) } ?? false, initial: true) { _, liked in
      session.player.nowPlaying?.setLiked(liked)
    }
    .onChange(of: session.player.notice) { _, notice in
      if let notice { model.toasts.push(notice.text, tone: notice.isError ? .error : .info) }
    }
    // Health and the requests, polled for as long as this account is the one shown (closing the session stops them).
    .task(id: session.key) { session.discover.start() }
    .onChange(of: scenePhase) { _, phase in
      model.isActive = phase == .active
      // Back on screen: the app may have been suspended, so health and the requests are asked for at once.
      if phase == .active { session.discover.becameActive() }
    }
    // The account's rights changed (may request): Request buttons follow before the next health check.
    .onChange(of: model.store.activeAccount?.account) { _, account in
      if let account, account.id == session.account.id { session.discover.update(account) }
    }
  }

  /// Settings → Appearance → Stats for nerds.
  private var stats: some View {
    StatsForNerdsOverlay(
      player: session.player, appearance: model.appearance, toasts: model.toasts,
      metadata: { [api = session.api] id in try? await api.send(API.Library.trackMetadata(id: id)) })
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
