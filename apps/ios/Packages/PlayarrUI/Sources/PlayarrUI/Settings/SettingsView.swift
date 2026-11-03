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
      if session.account.role == .admin {
        Section {
          ForEach(SettingsPanel.server, id: \.self) { panel in
            NavigationLink(panel.title, value: Route.settingsPanel(panel))
          }
        } header: {
          Text("Server")
        } footer: {
          Text("These settings apply to everyone.")
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
  }
}

/// One panel of Settings.
struct SettingsPanelView: View {
  let panel: SettingsPanel
  let session: AccountSession
  @Environment(AppModel.self) private var app

  var body: some View {
    switch panel {
    case .playback: PlaybackPanel(settings: app.playback)
    case .appearance: AppearancePanel(appearance: app.appearance)
    #if DEBUG
      case .playerLab:
        if let client = session.client { PlayerLabView(player: session.player, client: client) }
    #endif
    default: PlaceholderPage(title: panel.title)
    }
  }
}
