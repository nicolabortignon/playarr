import PlayarrAPI
import SwiftUI

/// Settings (apps/web/src/pages/Settings.tsx): who's signed in, then the panels in groups (`SettingsGroup`): This
/// device · Server for an admin, This device · Your account · Server for a member, who can read the server's but not
/// change them. Your listening isn't a setting: it's in Library and the account menu.
struct SettingsView: View {
  let session: AccountSession
  @Environment(AppModel.self) private var app
  @Environment(Theme.self) private var theme

  var body: some View {
    List {
      Section {
        // A row that opens Accounts, drawn as one: the words in the text color, not the accent, which is for actions
        // (docs/design.md, Words), and a chevron for where it leads.
        Button { app.showingAccounts = true } label: {
          HStack {
            LabeledContent("Signed in as \(session.account.name)", value: session.serverName)
            Image(systemName: "chevron.right").font(.sans(.footnote).weight(.semibold)).foregroundStyle(.tertiary)
              .accessibilityHidden(true)
          }
          .foregroundStyle(.paper)
        }
        .accessibilityHint("Switch accounts or add one")
      }
      ForEach(SettingsGroup.groups(for: role), id: \.title) { group in
        Section {
          ForEach(group.panels, id: \.self) { panel in
            NavigationLink(panel.title, value: Route.settingsPanel(panel))
              .accessibilityIdentifier("settings.\(panel.rawValue)")
          }
        } header: {
          Text(group.title)
        } footer: {
          if let note = group.note { Text(note) }
        }
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
    // Its rows are lighter than the page: the accent lifted to read on them.
    .tint(theme.listAccent.color)
  }

  /// The store's copy, which follows a role changed in Settings → Accounts.
  private var role: AccountRole { app.store.activeAccount?.account.role ?? session.account.role }
}

/// One panel of Settings.
struct SettingsPanelView: View {
  let panel: SettingsPanel
  let session: AccountSession
  @Environment(AppModel.self) private var app
  @Environment(Theme.self) private var theme

  var body: some View {
    // A system list, its sheets too: the accent lifted to read on their rows ("Sign out on this device", "Add source").
    content.tint(theme.listAccent.color)
  }

  @ViewBuilder
  private var content: some View {
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
        accountChanged: { [store = app.store, key = session.key] account in store.update(account, on: key.serverId) },
        // The setup links made on this device, kept for the server (the demo keeps them only while it runs).
        invites: session.client == nil ? InviteStore() : InviteStore(file: InviteStore.file(serverId: session.key.serverId)),
        toast: { [toasts = session.toasts] in toasts.push($0) })
    case .mixes: MixesPanel(api: session.api, isAdmin: isAdmin, mixesChanged: { Task { await session.mixes.load() } })
    case .analysis: AnalysisPanel(api: session.api, isAdmin: isAdmin)
    case .requests: RequestsPanel(api: session.api, isAdmin: isAdmin, requestsChanged: { session.discover.invalidate([.requests, .health]) })
    case .updates: UpdatesPanel(api: session.api, isAdmin: isAdmin)
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
