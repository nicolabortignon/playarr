import PlayarrAPI
import SwiftUI

/// Settings → Updates.
public struct UpdatesPanel: View {
  @State private var model: UpdatesModel

  private let isAdmin: Bool

  /// `isAdmin`: a member reads only that an admin changes these (the server doesn't show them the settings).
  public init(api: any APISending, isAdmin: Bool = true) {
    _model = State(initialValue: UpdatesModel(api: api))
    self.isAdmin = isAdmin
  }

  public var body: some View {
    Form {
      if !isAdmin {
        AdminOnlyNotice()
      } else if let info = model.info {
        Section { Text(UpdatesModel.intro).font(.footnote).foregroundStyle(.secondary) }
        Section("Version") {
          Text(model.versionText)
          if let installed = model.installedText() { Text(installed).font(.footnote).foregroundStyle(.secondary) }
          if let latest = model.latestText() { Text(latest).font(.footnote).foregroundStyle(.secondary) }
        }
        if let notice = model.notice { InlineMessage(text: notice) }
        if let unavailable = model.unavailable {
          Section("Automatic updates") {
            Text(unavailable.text)
            if let command = unavailable.command { Text(command).font(.body.monospaced()).textSelection(.enabled) }
          }
        } else {
          // Servers from before channels follow main, with no choice to show.
          if let channel = info.channel {
            Section {
              Picker("Channel", selection: Binding(get: { channel }, set: { value in Task { await model.setChannel(value) } })) {
                ForEach(UpdatesModel.channels, id: \.channel) { Text($0.label).tag($0.channel) }
              }
              .pickerStyle(.segmented)
            } header: {
              Text("Channel")
            } footer: {
              Text(UpdatesModel.note(for: channel))
            }
          }
          Section("Automatic updates") {
            Toggle(isOn: Binding(get: { info.enabled }, set: { on in Task { await model.setEnabled(on) } })) {
              Text("Update Playarr from GitHub automatically")
              Text("Only Playarr’s own releases, or its main branch on Edge, are ever installed.")
            }
            Picker("Check every", selection: Binding(get: { info.intervalMinutes }, set: { value in Task { await model.setInterval(value) } })) {
              ForEach(UpdatesModel.intervals, id: \.minutes) { Text($0.label).tag($0.minutes) }
            }
            .disabled(!info.enabled)
          }
          Section("Last check") {
            let last = model.lastCheck()
            Text(last.text).foregroundStyle(last.failed ? .danger : .primary)
            Button(model.checkLabel, systemImage: "arrow.clockwise") { Task { await model.checkNow() } }
              .disabled(model.busy || model.checking)
            if let log = info.log {
              DisclosureGroup("Show log") {
                ScrollView(.horizontal) { Text(log).font(.caption.monospaced()).textSelection(.enabled) }
              }
            }
          }
        }
      } else if let error = model.loadError {
        InlineMessage(text: error)
      } else {
        ProgressView()
      }
    }
    .navigationTitle("Updates")
    .task { if isAdmin { await model.poll() } }
  }
}
