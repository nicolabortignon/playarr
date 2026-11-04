import PlayarrAPI
import SwiftUI

/// Settings → Analysis: the background switch and queue, then one section per analysis with its progress
/// bar, "Analyse the N left" and "Reanalyse the entire collection" (after asking), and "Reanalyse everything".
public struct AnalysisPanel: View {
  @State private var model: AnalysisModel
  @State private var asking: AnalysisModel.Row?
  @State private var askingEverything = false

  public init(api: any APISending) {
    _model = State(initialValue: AnalysisModel(api: api))
  }

  public var body: some View {
    Form {
      if let progress = model.progress {
        Section("In the background") {
          if model.analyzeLibrary != nil {
            Toggle(isOn: Binding(get: { model.analyzeLibraryShown }, set: { on in Task { await model.setAnalyzeLibrary(on) } })) {
              Text("Analyse every song in the library")
              Text(AnalysisText.switchDescription(progress))
            }
            .disabled(!progress.enabled)
          }
          Text(model.queueText).font(.footnote).foregroundStyle(.secondary)
          if model.offersEverything {
            Button("Reanalyse everything") { askingEverything = true }.disabled(model.running)
          }
          if let notice = model.notice { InlineMessage(text: notice, isError: model.failed) }
        }
        ForEach(model.rows) { row in
          Section {
            Text(row.text).font(.footnote)
            if row.showsBar {
              ProgressView(value: Double(row.done), total: Double(max(row.of, 1))).accessibilityLabel(row.meter)
            }
            if row.canRun {
              if let left = row.leftLabel {
                Button(left) { Task { await model.run(row.kind) } }.disabled(model.running)
              }
              Button(row.againLabel) { asking = row }.disabled(model.running)
            }
          } header: {
            Text(row.title)
          } footer: {
            Text(row.description)
          }
        }
      } else if let error = model.loadError {
        InlineMessage(text: error)
      } else {
        ProgressView()
      }
    }
    .navigationTitle("Analysis")
    .task { await model.poll() }
    .alert(asking?.againQuestion ?? "", isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }), presenting: asking) { row in
      Button("Cancel", role: .cancel) {}
      Button(row.againLabel) { Task { await model.run(row.kind, again: true) } }
    } message: { row in
      Text(row.againExplain)
    }
    .alert(AnalysisText.everythingTitle, isPresented: $askingEverything) {
      Button("Cancel", role: .cancel) {}
      Button("Reanalyse everything") { Task { await model.run(nil, again: true) } }
    } message: {
      Text(AnalysisText.everythingExplain(audio: model.progress?.enabled ?? false))
    }
  }
}
