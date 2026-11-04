import SwiftUI

/// The tabs or the iPad layout, whichever the window's width calls for (`ShellLayout`), switching as it's resized
/// (Split View, Slide Over, Stage Manager, turning an iPad mini) without losing the page. It also keeps where the
/// app is in the scene's storage, so a window iOS closed in the background opens where it was.
struct AdaptiveShell: View {
  let session: AccountSession
  @SceneStorage("router") private var saved: Data?
  @State private var restored = false
  @Environment(AppModel.self) private var app
  #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
  #endif

  var body: some View {
    let router = session.router
    GeometryReader { proxy in
      let wanted = ShellLayout.choose(regularWidth: regularWidth, width: proxy.size.width)
      Group {
        switch router.layout {
        case .tabs: TabShell(session: session)
        case .split: SplitShell(session: session)
        }
      }
      .onAppear {
        restore()
        router.setLayout(wanted)
      }
      .onChange(of: wanted) { _, layout in router.setLayout(layout) }
    }
    .onChange(of: router.snapshot(account: account)) { _, snapshot in saved = snapshot.data }
  }

  private var regularWidth: Bool {
    #if os(iOS)
      sizeClass == .regular
    #else
      true
    #endif
  }

  private var account: String { "\(session.key.serverId)/\(session.key.accountId)" }

  private func restore() {
    guard !restored, app.restoresPlace else { return }
    restored = true
    if let snapshot = RouterSnapshot(data: saved) {
      session.router.restore(snapshot, account: account, hasSong: session.player.queue.currentTrack != nil)
    }
  }
}
