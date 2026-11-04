import SwiftUI

/// Settings → Mixes → ListenBrainz: send what this account plays to its ListenBrainz profile.
struct ListenBrainzSection: View {
  @Bindable var model: ListenBrainzModel

  var body: some View {
    if let info = model.info {
      Section {
        if !info.connected {
          SecureField(ListenBrainzModel.tokenHelp, text: $model.token).adminPlainField()
          if let page = ListenBrainzModel.tokenPage { Link("listenbrainz.org/settings", destination: page).font(.footnote) }
          Button(model.busy ? "Checking…" : "Connect") { Task { await model.connect() } }.disabled(!model.canConnect)
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
        if let notice = model.notice { InlineMessage(text: notice, isError: model.failed) }
      } header: {
        Text("ListenBrainz")
      } footer: {
        Text(ListenBrainzModel.intro)
      }
    }
  }
}
