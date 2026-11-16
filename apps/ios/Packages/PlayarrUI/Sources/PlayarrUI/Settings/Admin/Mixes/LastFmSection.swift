import PlayarrAPI
import SwiftUI

/// Settings → Mixes → Last.fm (LastFmModel).
struct LastFmSection: View {
  @Bindable var model: LastFmModel
  let isAdmin: Bool

  var body: some View {
    if let info = model.info {
      Section {
        if !info.available {
          if isAdmin {
            Text(LastFmModel.appHelp).font(.footnote).foregroundStyle(.secondary)
            if let page = LastFmModel.appPage { Link("last.fm/api/account/create", destination: page).font(.footnote) }
            TextField("API key", text: $model.apiKey).adminPlainField()
            SecureField("Shared secret", text: $model.secret).adminPlainField()
            Button(model.busy ? "Checking…" : "Add Last.fm") { Task { await model.addApp() } }.disabled(!model.canAddApp)
          } else {
            Text("An admin can add Last.fm to this server.").font(.footnote).foregroundStyle(.secondary)
          }
        } else if !info.connected {
          if let waiting = model.waiting, let page = URL(string: waiting.url) {
            Text("Allow Playarr on Last.fm, then come back here and finish.").font(.footnote).foregroundStyle(.secondary)
            Link("Allow Playarr on Last.fm", destination: page)
            Button(model.busy ? "Finishing…" : "Finish connecting") { Task { await model.finish() } }.disabled(model.busy)
            Button("Cancel", role: .cancel) { model.cancel() }
          } else {
            Button(model.busy ? "Asking Last.fm…" : "Connect Last.fm") { Task { await model.connect() } }.disabled(model.busy)
          }
        } else {
          Toggle(isOn: Binding(get: { info.enabled }, set: { on in Task { await model.setEnabled(on) } })) {
            Text(model.switchLabel)
            Text(model.switchDetail)
          }
          if let earlier = model.earlierLabel {
            Button(earlier) { Task { await model.sendEarlier() } }.disabled(model.busy)
          }
          Button("Disconnect") { Task { await model.disconnect() } }.disabled(model.busy)
        }
        if let line = model.appLine {
          Text(line).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
          Button("Remove it (everyone here disconnects)", role: .destructive) { Task { await model.removeApp() } }.disabled(model.busy)
        }
        if let notice = model.notice { InlineMessage(text: notice, isError: model.failed) }
      } header: {
        Text("Last.fm")
      } footer: {
        Text(LastFmModel.intro)
      }
    }
  }
}
