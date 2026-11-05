import PlayarrAPI
import SwiftUI

/// The signed-in app: the phone's tabs with the mini player, or on a wide iPad window the sidebar, page, side column
/// and player bar (`AdaptiveShell`); Now Playing over everything, and toasts.
struct AppShell: View {
  let model: AppModel
  let session: AccountSession
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    @Bindable var router = session.router
    // The phone's tabs, or the iPad's sidebar and player bar, as wide as the window is.
    AdaptiveShell(session: session)
    .nowPlayingCover(isPresented: $router.nowPlaying) {
      // In a stack for its bar, which only the iPhone Duo's cover screen shows (its buttons in the column on the right).
      NavigationStack {
        NowPlayingView(session: session)
          .underTheRail()
      }
      // Show metadata and Edit mix points from Now Playing's menu open over it.
      .trackSheets(player: session.player, active: router.nowPlaying)
      .addToPlaylistSheet(session, active: router.nowPlaying)
      .environment(session).environment(session.discover).environment(model.theme).environment(model.appearance)
      .environment(\.reducesMotion, model.appearance.reduceMotion(system: systemReduceMotion))
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
    .environment(\.reducesMotion, model.appearance.reduceMotion(system: systemReduceMotion))
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
      if phase == .active {
        session.discover.becameActive()
        Task { await model.refreshAccount() }
      }
    }
    #if os(iOS)
      // Settings → Appearance → Turn to open: turning the phone on its side with a song queued opens Now Playing,
      // straight into the sleeve (off by default, since every page turns too).
      .onReceive(NotificationCenter.default.publisher(for: UIDevice.orientationDidChangeNotification)) { _ in
        guard UIDevice.current.userInterfaceIdiom == .phone, UIDevice.current.orientation.isLandscape, model.appearance.turnToOpen,
          !router.nowPlaying, session.player.queue.currentTrack != nil, OrientationPolicy.nothingPresented
        else { return }
        router.nowPlaying = true
      }
      .onAppear { UIDevice.current.beginGeneratingDeviceOrientationNotifications() }
    #endif
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
}
