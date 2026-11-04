import PlayarrAPI
import SwiftUI

/// Settings (apps/web/src/pages/Settings.tsx): who's signed in, this device's Playback and Appearance, and for admins
/// the server's panels (built in phase 9).
struct SettingsView: View {
  let session: AccountSession
  @Environment(AppModel.self) private var app

  var body: some View {
    List {
      Section {
        Button { app.showingAccounts = true } label: {
          LabeledContent("Signed in as \(session.account.name)", value: session.serverName)
        }
        .accessibilityHint("Switch accounts or add one")
        NavigationLink("Your listening", value: Route.listening)
      }
      Section {
        NavigationLink(SettingsPanel.playback.title, value: Route.settingsPanel(.playback))
        NavigationLink(SettingsPanel.appearance.title, value: Route.settingsPanel(.appearance))
      } header: {
        Text("This device")
      } footer: {
        Text("These settings are for this device.")
      }
      Section {
        ForEach(SettingsPanel.server(for: role), id: \.self) { panel in
          NavigationLink(panel.title, value: Route.settingsPanel(panel))
            .accessibilityIdentifier("settings.\(panel.rawValue)")
        }
      } header: {
        Text(role == .admin ? "Server" : "Your account")
      } footer: {
        if role == .admin { Text("These settings apply to everyone.") }
      }
      #if DEBUG
        if session.client != nil {
          Section("Debug") { NavigationLink(SettingsPanel.playerLab.title, value: Route.settingsPanel(.playerLab)) }
        }
      #endif
      Section {
      } footer: {
        Text("Playarr \(app.appVersion.description)").frame(maxWidth: .infinity)
      }
    }
    .navigationTitle("Settings")
  }

  /// The store's copy, which follows a role changed in Settings → Accounts.
  private var role: AccountRole { app.store.activeAccount?.account.role ?? session.account.role }
}

/// One panel of Settings.
struct SettingsPanelView: View {
  let panel: SettingsPanel
  let session: AccountSession
  @Environment(AppModel.self) private var app

  var body: some View {
    switch panel {
    case .playback:
      PlaybackPanel(
        settings: app.playback, downloads: session.player.downloads, openDownloads: { session.router.open(.downloads) },
        locked: isLocked(.playback))
    case .appearance: AppearancePanel(appearance: app.appearance, locked: isLocked(.appearance))
    #if DEBUG
      case .playerLab:
        if let client = session.client { PlayerLabView(player: session.player, client: client) }
    #endif
    case .sources: SourcesPanel(api: session.api, libraryChanged: libraryChanged)
    case .accounts:
      AccountsPanel(
        api: session.api,
        signOutHere: { [store = app.store, key = session.key] in await store.signOut(key) },
        accountChanged: { [store = app.store, key = session.key] account in store.update(account, on: key.serverId) })
    case .mixes: MixesPanel(api: session.api, isAdmin: isAdmin, mixesChanged: { Task { await session.mixes.load() } })
    case .analysis: AnalysisPanel(api: session.api)
    case .requests: RequestsPanel(api: session.api, requestsChanged: { session.discover.invalidate([.requests, .health]) })
    case .updates: UpdatesPanel(api: session.api)
    }
  }

  /// An admin has stopped this account from changing this setting on its devices (the store's copy follows changes).
  private func isLocked(_ setting: DeviceSetting) -> Bool {
    (app.store.activeAccount?.account ?? session.account).locked?.contains(setting) == true
  }

  private var isAdmin: Bool { (app.store.activeAccount?.account.role ?? session.account.role) == .admin }

  /// A source synced or was removed, or files moved: everything showing the library is asked again.
  private func libraryChanged() {
    session.discover.invalidate(CacheFamily.allCases)
    Task { await session.mixes.load() }
  }
}
