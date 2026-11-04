import PlayarrAPI
import SwiftUI

/// Settings → Requests.
public struct RequestsPanel: View {
  @State private var model: RequestSettingsModel

  public init(api: any APISending, requestsChanged: @escaping @MainActor () -> Void = {}) {
    _model = State(initialValue: RequestSettingsModel(api: api, requestsChanged: requestsChanged))
  }

  public var body: some View {
    Form {
      if let info = model.info {
        if !info.lidarr {
          Text("Requests need a Lidarr source. You can add one in Sources.")
        } else {
          if let notice = model.notice { InlineMessage(text: notice) }
          Section("Requests") {
            Toggle(isOn: Binding(get: { info.enabled }, set: { on in Task { await model.setEnabled(on) } })) {
              Text("Let people request albums")
              Text("Off hides every Request button, for everyone, and Playarr refuses new requests.")
            }
            Toggle(isOn: Binding(get: { info.searchOnAdd }, set: { on in Task { await model.setSearchOnAdd(on) } })) {
              Text("Search for an album as soon as it’s requested")
              Text("Off only adds the album to Lidarr as wanted, and Lidarr searches for it on its own schedule.")
            }
          }
          destination(info)
        }
      } else if let error = model.loadError {
        InlineMessage(text: error)
      } else {
        ProgressView()
      }
    }
    .navigationTitle("Requests")
    .task { await model.load() }
  }

  private func destination(_ info: RequestSettingsInfo) -> some View {
    Section {
      if let problem = model.optionsProblem {
        InlineMessage(text: problem)
        Button(model.retrying ? "Retrying…" : "Retry", systemImage: "arrow.clockwise") { Task { await model.retry() } }.disabled(model.retrying)
      } else {
        Picker("Root folder", selection: Binding(get: { info.rootFolderPath }, set: { value in Task { await model.setRootFolder(value) } })) {
          ForEach(model.rootFolders, id: \.self) { Text($0.label).tag($0.value) }
        }
        Picker("Quality profile", selection: Binding(get: { info.qualityProfileId }, set: { value in Task { await model.setQualityProfile(value) } })) {
          ForEach(model.qualityProfiles, id: \.self) { Text($0.label).tag($0.value) }
        }
        Picker("Metadata profile", selection: Binding(get: { info.metadataProfileId }, set: { value in Task { await model.setMetadataProfile(value) } })) {
          ForEach(model.metadataProfiles, id: \.self) { Text($0.label).tag($0.value) }
        }
      }
    } header: {
      Text("Where new artists go")
    } footer: {
      Text(
        "When a request brings in an artist Lidarr doesn’t have yet, it’s added with these. Artists already in Lidarr keep their own. \(RequestSettingsModel.defaultHelp)")
    }
  }
}
