import SwiftUI

/// Settings → Sources → Identifying songs: the AcoustID key.
struct MatchingSection: View {
  @Bindable var model: MatchingModel

  var body: some View {
    if let settings = model.settings {
      Section {
        if !settings.fingerprints {
          Text(MatchingModel.noFingerprints).font(.footnote)
        }
        if model.editing {
          SecureField("AcoustID application key", text: $model.key)
            .font(.body.monospaced())
            .adminPlainField()
            .accessibilityLabel("AcoustID key")
          Button("Save") { Task { await model.save() } }.disabled(!model.canSave)
        } else {
          HStack {
            Text("AcoustID key saved").font(.body.monospaced()).foregroundStyle(.secondary)
            Spacer()
            Button("Replace") { model.replacing = true }.buttonStyle(.borderless)
          }
        }
        if let error = model.error { InlineMessage(text: error) }
      } header: {
        Text("Identifying songs")
      } footer: {
        VStack(alignment: .leading, spacing: 4) {
          Text(MatchingModel.intro)
          if let page = MatchingModel.keyPage { Link("acoustid.org", destination: page) }
        }
      }
    }
  }
}
