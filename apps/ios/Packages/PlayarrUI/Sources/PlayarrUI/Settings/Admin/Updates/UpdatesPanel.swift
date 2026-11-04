import PlayarrAPI
import SwiftUI

/// Settings → Updates.
public struct UpdatesPanel: View {
  @State private var model: UpdatesModel

  public init(api: any APISending) {
    _model = State(initialValue: UpdatesModel(api: api))
  }

  public var body: some View {
    Form {
      if let info = model.info {
        Section { Text(UpdatesModel.intro).font(.footnote).foregroundStyle(.secondary) }
        Section("Version") {
          Text(model.versionText)
          if let latest = model.latestText { Text(latest).font(.footnote).foregroundStyle(.secondary) }
        }
        if let notice = model.notice { InlineMessage(text: notice) }
        if let unavailable = model.unavailable {
          Section("Automatic updates") {
            Text(unavailable.text)
            if let command = unavailable.command { Text(command).font(.body.monospaced()).textSelection(.enabled) }
          }
        } else {
          Section("Automatic updates") {
            Toggle(isOn: Binding(get: { info.enabled }, set: { on in Task { await model.setEnabled(on) } })) {
              Text("Update Playarr from GitHub automatically")
              Text("Only the main branch of Playarr’s repository is ever installed.")
            }
            Picker("Check every", selection: Binding(get: { info.intervalMinutes }, set: { value in Task { await model.setInterval(value) } })) {
              ForEach(UpdatesModel.intervals, id: \.minutes) { Text($0.label).tag($0.minutes) }
            }
            .disabled(!info.enabled)
          }
          Section("Last check") {
            let last = model.lastCheck()
            Text(last.text).foregroundStyle(last.failed ? .red : .primary)
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
    .task { await model.poll() }
  }
}
