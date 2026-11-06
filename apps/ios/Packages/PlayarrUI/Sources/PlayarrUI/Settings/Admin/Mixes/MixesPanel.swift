import PlayarrAPI
import SwiftUI

/// Settings → Mixes: admins choose which mixes Home shows and how they're made, which members see but can't
/// change; everyone sees their own listening history (and clears it) and their ListenBrainz link.
public struct MixesPanel: View {
  @State private var model: MixSettingsModel
  @State private var listenBrainz: ListenBrainzModel
  @State private var confirmClear = false

  public init(api: any APISending, isAdmin: Bool, mixesChanged: @escaping @MainActor () -> Void = {}) {
    _model = State(initialValue: MixSettingsModel(api: api, isAdmin: isAdmin, mixesChanged: mixesChanged))
    _listenBrainz = State(initialValue: ListenBrainzModel(api: api))
  }

  public var body: some View {
    Form {
      if let info = model.info {
        if let notice = model.notice { InlineMessage(text: notice, isError: model.failed) }
        if !model.isAdmin {
          Section { Text("Only an admin can change how mixes are made.").font(.footnote).foregroundStyle(.secondary) }
        }
        kinds.disabled(!model.isAdmin)
        howTheyreMade(info).disabled(!model.isAdmin)
        history(info)
        ListenBrainzSection(model: listenBrainz)
        if model.isAdmin {
          Section("Sound") { Text(MixSettingsModel.soundText).font(.footnote).foregroundStyle(.secondary) }
        }
      } else if let error = model.loadError {
        InlineMessage(text: error)
      } else {
        ProgressView()
      }
    }
    .navigationTitle(SettingsPanel.mixes.title)
    .task { await model.load() }
    .task { await listenBrainz.poll() }
  }

  private var kinds: some View {
    Section {
      ForEach(MixKinds.all, id: \.kind) { item in
        Toggle(isOn: Binding(get: { model.isEnabled(item.kind) }, set: { on in Task { await model.setEnabled(item.kind, on) } })) {
          Text(item.label)
          Text(item.description)
        }
      }
    } header: {
      Text("Your mixes")
    } footer: {
      Text("Made for you from your library and what you play, at the top of Home. These settings apply to everyone.")
    }
  }

  private func howTheyreMade(_ info: MixSettingsInfo) -> some View {
    Section("How they’re made") {
      VStack(alignment: .leading, spacing: 6) {
        LabeledContent("Time zone", value: model.timeZoneText)
        if model.isAdmin, let label = model.useDeviceZoneLabel {
          Button(label) { Task { await model.useDeviceTimeZone() } }.buttonStyle(.bordered)
        }
        Text("When hours, days and Mondays begin for everyone’s mixes.").font(.footnote).foregroundStyle(.secondary)
      }
      Picker("Songs per mix", selection: Binding(get: { info.length }, set: { value in Task { await model.setLength(value) } })) {
        ForEach(MixKinds.lengths, id: \.value) { Text($0.label).tag($0.value) }
      }
      Picker("Discovery Weekly", selection: Binding(get: { model.adventure }, set: { value in Task { await model.setAdventurous(value) } })) {
        ForEach(MixKinds.adventure, id: \.value) { Text($0.label).tag($0.value) }
      }
      Picker("Blast from the past: not heard for", selection: Binding(get: { info.blastDays }, set: { value in Task { await model.setBlastDays(value) } })) {
        ForEach(MixKinds.blast, id: \.value) { Text($0.label).tag($0.value) }
      }
      Picker("Genre mixes", selection: Binding(get: { info.genreMixes }, set: { value in Task { await model.setGenreMixes(value) } })) {
        ForEach(MixKinds.counts, id: \.value) { Text($0.label).tag($0.value) }
      }
      Picker("Decade mixes", selection: Binding(get: { info.decadeMixes }, set: { value in Task { await model.setDecadeMixes(value) } })) {
        ForEach(MixKinds.counts, id: \.value) { Text($0.label).tag($0.value) }
      }
    }
  }

  private func history(_ info: MixSettingsInfo) -> some View {
    Section {
      Toggle(isOn: Binding(get: { info.recordHistory }, set: { on in Task { await model.setRecordHistory(on) } })) {
        Text("Remember what’s played")
        Text("Off stops recording; the mixes keep using what’s already there.")
      }
      .disabled(!model.isAdmin)
      HStack {
        Text(model.historyText).font(.footnote)
        Spacer()
        Button("Clear history", systemImage: "trash") { confirmClear = true }
          .buttonStyle(.bordered)
          .disabled(!model.canClear)
          // Asked from its button, so a phone's popover points at it.
          .confirmLoss(MixSettingsModel.clearQuestion(plays: info.history.plays), isPresented: $confirmClear) {
            Task { await model.clearHistory() }
          }
      }
    } header: {
      Text("Listening history")
    } footer: {
      Text(MixSettingsModel.historyIntro)
    }
  }
}
