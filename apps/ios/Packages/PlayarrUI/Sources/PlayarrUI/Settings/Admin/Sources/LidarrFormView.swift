import SwiftUI

/// Lidarr's name, URL and API key, with Test and Save.
struct LidarrFormView: View {
  @State var model: LidarrFormModel
  let done: () -> Void

  var body: some View {
    Form {
      Section {
        TextField("Name", text: $model.name)
        TextField("URL", text: $model.url, prompt: Text("http://192.168.1.10:8686")).adminURLField()
      }
      Section {
        if model.replacingKey {
          TextField("API key", text: $model.apiKey, prompt: Text(model.keySaved ? "New API key" : "API key"))
            .font(.body.monospaced())
            .adminPlainField()
        } else {
          HStack {
            Text("API key")
            Spacer()
            Text("Saved").font(.body.monospaced()).foregroundStyle(.secondary)
            Button("Replace") { model.replacingKey = true }.buttonStyle(.borderless)
          }
        }
      } footer: {
        Text("In Lidarr: Settings → General → Security")
      }
      if model.source != nil {
        Toggle("Use this source", isOn: $model.enabled)
      }
      Section {
        if model.test == .running {
          Label("Connecting…", systemImage: "hourglass").foregroundStyle(.secondary)
        } else if let text = model.testText, case .done(let result) = model.test {
          Label(text, systemImage: result.ok ? "checkmark" : "exclamationmark.triangle").foregroundStyle(result.ok ? .success : .danger)
        }
        if let error = model.error { InlineMessage(text: error) }
        Button("Test") { Task { await model.runTest() } }.disabled(!model.canTest)
        Button(model.saving ? "Saving…" : "Save") {
          Task { if await model.save() { done() } }
        }
        .disabled(!model.canSave)
      }
    }
  }
}
